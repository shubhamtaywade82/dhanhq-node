import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { eventBus } from '../services/eventBus';
import { journal } from '../services/journal';
import type { MarketDataService } from '../services/marketData';
import { toTrailConfig } from '../services/marketData';
import type { RiskEngine } from '../services/riskEngine';
import { buildSandboxPlaceRequest, resolveSandboxOptionLeg, roundToTick } from '../services/sandboxInstruments';
import { executePaperOrder, closePaperPosition } from '../db';

function dhanErrorDetail(e: any): string {
  return [e.errorCode, e.errorType, e.errorMessage].filter(Boolean).join(' | ');
}

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
    const gate = this.risk.canTrade();
    if (!gate.allowed) {
      eventBus.log('WARN', `Sandbox order REJECTED for ${correlation_id}: ${gate.reason}`, 'sandbox_engine');
      eventBus.emit('order', { kind: 'rejection', correlationId: correlation_id, reason: gate.reason });
      journal.append('order_result', { correlation_id, status: 'REJECTED', reason: gate.reason, mode: 'sandbox' });
      return { status: 'REJECTED', reason: gate.reason };
    }

    let secId = String(security_id);
    let qty = quantity;
    let seg = exchange_segment;
    let limitPrice = price;
    let sandboxContract: string | undefined;

    if (!params.underlying || params.strike == null || !params.option_type) {
      const reason = 'sandbox: missing underlying/strike/option_type — cannot map production securityId to sandbox scrip';
      journal.append('order_intent', { correlation_id, intent_id, params, risk_limits, mode: 'sandbox' });
      journal.append('order_result', { correlation_id, status: 'REJECTED', reason, mode: 'sandbox' });
      return { status: 'REJECTED', reason };
    }

    const leg = await resolveSandboxOptionLeg(this.client, {
      underlying: params.underlying,
      strike: Number(params.strike),
      optionType: params.option_type,
      expiry: params.expiry,
      exchangeSegment: exchange_segment,
    });
    if (!leg) {
      const reason = `sandbox: no ${params.underlying} ${params.strike}${params.option_type} in sandbox scrip master`;
      journal.append('order_intent', { correlation_id, intent_id, params, risk_limits, mode: 'sandbox' });
      journal.append('order_result', { correlation_id, status: 'REJECTED', reason, mode: 'sandbox' });
      return { status: 'REJECTED', reason };
    }
    if (params.underlying.toUpperCase() === 'SENSEX') {
      const reason = 'sandbox: SENSEX BSE_FNO not supported by Dhan sandbox (DH-906)';
      journal.append('order_intent', { correlation_id, intent_id, params, risk_limits, mode: 'sandbox' });
      journal.append('order_result', { correlation_id, status: 'REJECTED', reason, mode: 'sandbox' });
      return { status: 'REJECTED', reason };
    }

    if (leg.securityId !== secId) {
      eventBus.log('INFO', `Sandbox remap ${secId}→${leg.securityId} (${leg.displayName || params.symbol})`, 'sandbox_engine');
    }
    secId = leg.securityId;
    qty = leg.quantity;
    seg = leg.exchangeSegment;
    limitPrice = roundToTick(price, leg.tickSize);
    sandboxContract = leg.displayName;

    journal.append('order_intent', {
      correlation_id, intent_id,
      params: { ...params, security_id: secId, quantity: qty, exchange_segment: seg, price: limitPrice, sandbox_contract: sandboxContract },
      risk_limits, mode: 'sandbox',
    });

    eventBus.log('TRADE', `Placing SANDBOX order ${transaction_type} ${qty} × ${secId} (${correlation_id})`, 'sandbox_engine');

    try {
      const placed = await this.client.orders.place(buildSandboxPlaceRequest({
        correlationId: correlation_id,
        securityId: secId,
        exchangeSegment: seg,
        transactionType: transaction_type,
        orderType: order_type,
        quantity: qty,
        price: limitPrice,
        productType: params.product_type || 'INTRADAY',
      }));

      const orderId = placed.data.orderId;
      const settled = await this.client.orders.getById(orderId).catch(() => placed.data);

      const fillPayload = {
        intent_id,
        correlation_id,
        mode: 'sandbox' as const,
        is_paper: false,
        fill_price: (settled as any).averagePrice ?? limitPrice,
        quantity: (settled as any).filledQty ?? qty,
        security_id: secId,
        order_id: orderId,
        filled_at: new Date().toISOString(),
      };

      eventBus.emit('order', { kind: 'fill', ...fillPayload });
      journal.append('order_result', { status: (settled as any).orderStatus || 'TRADED', ...fillPayload });

      this.risk.getPortfolio().recordOrderOutcome({ status: 'TRADED' });
      this.risk.getPortfolio().invalidate();

      await executePaperOrder({
        symbol: sandboxContract || params.symbol || secId,
        securityId: secId,
        exchangeSegment: seg,
        transactionType: transaction_type,
        orderType: order_type,
        productType: params.product_type || 'INTRADAY',
        quantity: (settled as any).filledQty ?? qty,
        price: (settled as any).averagePrice ?? limitPrice,
        correlationId: correlation_id.slice(0, 25),
        stopLoss: risk_limits?.stop_loss,
        target: risk_limits?.target,
        trailingStop: risk_limits?.trailing_stop,
      }, async () => 0).catch(() => {});

      if (risk_limits && (risk_limits.stop_loss || risk_limits.trailing_stop || risk_limits.target)) {
        const filledQty = (settled as any).filledQty ?? qty;
        this.market.monitor.track({
          securityId: secId,
          exchangeSegment: seg,
          quantity: transaction_type === 'SELL' ? -filledQty : filledQty,
          entryPrice: (settled as any).averagePrice ?? limitPrice,
          stopLoss: risk_limits.stop_loss,
          target: risk_limits.target,
          trail: toTrailConfig(risk_limits.trailing_stop),
        });
      }

      this.market.addInstruments([{ securityId: secId, exchangeSegment: seg }]);
      return { status: (settled as any).orderStatus || 'TRADED', orderId, ...fillPayload };
    } catch (e: any) {
      const detail = dhanErrorDetail(e);
      const reason = detail ? `${e.message} (${detail})` : e.message;
      this.risk.getPortfolio().recordOrderOutcome({ status: 'REJECTED' });
      eventBus.log('ERROR', `Sandbox order FAILED for ${correlation_id}: ${reason}`, 'sandbox_engine');
      journal.append('order_result', { correlation_id, status: 'REJECTED', reason, mode: 'sandbox' });
      return { status: 'REJECTED', reason };
    }
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
  async closeLeg(leg: { securityId: string; exchangeSegment?: string; qty: number; side: 'BUY' | 'SELL'; instrument?: string }, price: number, correlationId: string = `u_${leg.securityId}_${Date.now().toString(36)}`.slice(0, 25)): Promise<{ status: string; orderId?: string }> {
    const placed = await this.client.orders.place(buildSandboxPlaceRequest({
      correlationId,
      securityId: String(leg.securityId),
      exchangeSegment: leg.exchangeSegment || 'NSE_FNO',
      transactionType: leg.side === 'BUY' ? 'SELL' : 'BUY',
      orderType: 'MARKET',
      quantity: leg.qty,
      price,
      productType: 'INTRADAY',
    })).catch(() => null);
    if (!placed) return { status: 'REJECTED' };
    const orderId = placed.data.orderId;
    const settled = await this.client.orders.getById(orderId).catch(() => placed.data);
    await closePaperPosition(leg.instrument || leg.securityId, price, async () => 0, 'EXIT').catch(() => {});
    return { status: (settled as any).orderStatus || 'TRADED', orderId };
  }
}
