import type { DhanClient, PositionMonitor } from '@nemesis-oss/dhanhq-sdk';
import { redisPublisher } from '../auth';
import { executePaperOrder } from '../db';
import { eventBus } from '../services/eventBus';
import type { MarketDataService } from '../services/marketData';
import type { RiskEngine } from '../services/riskEngine';

/**
 * Paper execution engine.
 *
 * Fills are priced from the LIVE market LTP served by MarketDataService
 * (DhanHQ binary WS or REST quotes) — never from a constant. A slippage
 * model (ticks adverse to the aggressor) is applied on top of the real
 * price. If no live price is known for the instrument the order is
 * REJECTED, exactly like a broker would reject an unpriceable order.
 */
export class PaperExecutionEngine {
  private client: DhanClient;
  private monitor: PositionMonitor;
  private market: MarketDataService;
  private risk: RiskEngine;
  private latencyMs: number;
  private slippageTicks: number;
  private tickSize = 0.05;

  constructor(client: DhanClient, monitor: PositionMonitor, market: MarketDataService, risk: RiskEngine, latencyMs = 50, slippageTicks = 1) {
    this.client = client;
    this.monitor = monitor;
    this.market = market;
    this.risk = risk;
    this.latencyMs = latencyMs;
    this.slippageTicks = slippageTicks;
  }

  async placeOrder(intent: any): Promise<any> {
    const { correlation_id, intent_id, params, risk_limits } = intent;
    const { security_id, quantity, transaction_type, order_type = 'MARKET', price = 0 } = params;
    const symbol = params.symbol || params.trading_symbol || `SEC_${security_id}`;

    // Risk gate — the kill switch and EOD window block paper fills too.
    const gate = this.risk.canTrade();
    if (!gate.allowed) {
      eventBus.log('WARN', `Paper order REJECTED for ${correlation_id}: ${gate.reason}`, 'paper_engine');
      eventBus.emit('order', { kind: 'rejection', correlationId: correlation_id, reason: gate.reason });
      return { status: 'REJECTED', reason: gate.reason };
    }

    // Resolve the fill price from the live market.
    let referencePrice = price > 0 ? Number(price) : this.market.getLtp(security_id);
    if (order_type === 'MARKET') {
      referencePrice = this.market.getLtp(security_id) ?? (price > 0 ? Number(price) : null);
    }
    if (referencePrice == null || referencePrice <= 0) {
      eventBus.log('WARN', `Paper order REJECTED for ${correlation_id}: no live LTP for ${symbol} (security ${security_id})`, 'paper_engine');
      eventBus.emit('order', { kind: 'rejection', correlationId: correlation_id, reason: 'No live LTP available for instrument' });
      return { status: 'REJECTED', reason: 'No live LTP available for instrument' };
    }

    // Simulate network transmission latency.
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    const fillPrice = transaction_type === 'BUY'
      ? referencePrice + this.slippageTicks * this.tickSize
      : referencePrice - this.slippageTicks * this.tickSize;

    const trailDist = typeof risk_limits?.trailing_stop === 'object'
      ? Number(risk_limits.trailing_stop.distance)
      : (risk_limits?.trailing_stop ? Number(risk_limits.trailing_stop) : undefined);

    const result = await executePaperOrder({
      symbol,
      securityId: String(security_id),
      exchangeSegment: params.exchange_segment || 'NSE_FNO',
      transactionType: transaction_type,
      orderType: order_type,
      productType: params.product_type || 'INTRADAY',
      quantity,
      price: Number(fillPrice.toFixed(2)),
      correlationId: correlation_id,
      stopLoss: risk_limits?.stop_loss ? Number(risk_limits.stop_loss) : undefined,
      target: risk_limits?.target ? Number(risk_limits.target) : undefined,
      trailingStop: trailDist,
    });

    const fillPayload = {
      intent_id,
      correlation_id,
      is_paper: true,
      fill_price: result.fillPrice,
      quantity,
      security_id,
      symbol,
      latency_ms: result.latencyMs,
      filled_at: new Date().toISOString(),
    };

    eventBus.log('TRADE', `Paper fill ${transaction_type} ${quantity} ${symbol} @ ₹${result.fillPrice.toFixed(2)} (${correlation_id})`, 'paper_engine');
    eventBus.emit('order', { kind: 'fill', ...fillPayload });
    await redisPublisher.publish('dhan:execution:fills', JSON.stringify(fillPayload)).catch(() => {});

    // Stop-loss / target / trailing monitoring via SDK PositionMonitor,
    // fed by MarketDataService ticks (live, not dead code anymore).
    if (risk_limits && (risk_limits.stop_loss || risk_limits.trailing_stop || risk_limits.target)) {
      this.monitor.track({
        securityId: String(security_id),
        exchangeSegment: params.exchange_segment || 'NSE_FNO',
        quantity,
        entryPrice: fillPrice,
        stopLoss: risk_limits.stop_loss,
        target: risk_limits.target,
        trail: risk_limits.trailing_stop,
      });
    }

    // Keep the market data service subscribed to this instrument so the
    // position keeps being marked and monitored.
    this.market.addInstruments([{ securityId: String(security_id), exchangeSegment: params.exchange_segment || 'NSE_FNO' }]);

    return { status: 'TRADED', ...fillPayload };
  }
}
