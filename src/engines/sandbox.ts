import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { eventBus } from '../services/eventBus';
import { journal } from '../services/journal';
import type { MarketDataService } from '../services/marketData';
import type { RiskEngine } from '../services/riskEngine';

/**
 * Sandbox execution engine — places orders through DhanHQ's real Sandbox
 * API (paper trading, flat ₹100 fills, no order-update WebSocket).
 *
 * Unlike LiveExecutionEngine, there's no OrderTracker/WS to wait on:
 * sandbox fills are synchronous, so a single getById() right after place()
 * is enough to read back the settled status. Market data/WS stay on the
 * Real client (this.market), shared with Paper/Live — sandbox is order
 * routing only.
 */
export class SandboxExecutionEngine {
  private client: DhanClient;
  private market: MarketDataService;
  private risk: RiskEngine;

  constructor(client: DhanClient, market: MarketDataService, risk: RiskEngine) {
    this.client = client;
    this.market = market;
    this.risk = risk;
  }

  async placeOrder(intent: any): Promise<any> {
    const { correlation_id, intent_id, params, risk_limits } = intent;
    const { security_id, quantity, transaction_type, order_type = 'MARKET', exchange_segment = 'NSE_FNO', price = 0 } = params;
    // ponytail: risk_limits (SL/target/trailing) aren't tracked here — no
    // PositionMonitor wired to this engine, since sandbox mode is for
    // verifying real order routing/rejections, not SL/target management.
    // Add a monitor param if sandbox trades need live stop management.
    journal.append('order_intent', { correlation_id, intent_id, params, risk_limits, mode: 'sandbox' });

    const gate = this.risk.canTrade();
    if (!gate.allowed) {
      eventBus.log('WARN', `Sandbox order REJECTED for ${correlation_id}: ${gate.reason}`, 'sandbox_engine');
      eventBus.emit('order', { kind: 'rejection', correlationId: correlation_id, reason: gate.reason });
      journal.append('order_result', { correlation_id, status: 'REJECTED', reason: gate.reason });
      return { status: 'REJECTED', reason: gate.reason };
    }

    eventBus.log('TRADE', `Placing SANDBOX order ${transaction_type} ${quantity} × ${security_id} (${correlation_id})`, 'sandbox_engine');

    const placed = await this.client.orders.place({
      correlationId: correlation_id,
      securityId: String(security_id),
      exchangeSegment: exchange_segment,
      transactionType: transaction_type,
      orderType: order_type,
      quantity,
      price,
      productType: params.product_type || 'INTRADAY',
    });

    const orderId = placed.data.orderId;
    const settled = await this.client.orders.getById(orderId).catch(() => placed.data);

    const fillPayload = {
      intent_id,
      correlation_id,
      is_paper: true,
      fill_price: (settled as any).averagePrice ?? price,
      quantity: (settled as any).filledQty ?? quantity,
      security_id,
      order_id: orderId,
      filled_at: new Date().toISOString(),
    };

    eventBus.emit('order', { kind: 'fill', ...fillPayload });
    journal.append('order_result', { status: (settled as any).orderStatus || 'TRADED', ...fillPayload });

    this.market.addInstruments([{ securityId: String(security_id), exchangeSegment: exchange_segment }]);
    return { status: (settled as any).orderStatus || 'TRADED', orderId, ...fillPayload };
  }

  /**
   * Reverses a filled leg via a real MARKET order at the Sandbox account —
   * used to unwind a partial multi-leg fill. Deliberately bypasses
   * risk.canTrade(): an exit must keep working while the entry gate blocks
   * new orders (kill switch, system not READY), same as PortfolioSource.
   * closePosition() does for paper/live. Sandbox fills live only at the
   * Dhan Sandbox account — never in PortfolioSource — so unwinding here
   * cannot go through portfolio.closePosition() like the other two modes.
   */
  async closeLeg(leg: { securityId: string; exchangeSegment?: string; qty: number; side: 'BUY' | 'SELL'; instrument?: string }, price: number, correlationId: string = `unwind_${leg.securityId}_${Date.now()}`): Promise<{ status: string; orderId?: string }> {
    const placed = await this.client.orders.place({
      correlationId,
      securityId: String(leg.securityId),
      exchangeSegment: (leg.exchangeSegment || 'NSE_FNO') as any,
      transactionType: leg.side === 'BUY' ? 'SELL' : 'BUY',
      orderType: 'MARKET',
      quantity: leg.qty,
      price,
      productType: 'INTRADAY',
    }).catch(() => null);
    if (!placed) return { status: 'REJECTED' };
    const orderId = placed.data.orderId;
    const settled = await this.client.orders.getById(orderId).catch(() => placed.data);
    return { status: (settled as any).orderStatus || 'TRADED', orderId };
  }
}
