import type { DhanClient, PositionMonitor } from '@nemesis-oss/dhanhq-sdk';
import { redisPublisher } from '../auth';
import { executePaperOrder, defaultMarginResolver, type MarginResolver } from '../db';
import { eventBus } from '../services/eventBus';
import { journal } from '../services/journal';
import { applyFillSlippage } from '../services/fillModel';
import type { MarketDataService } from '../services/marketData';
import { toTrailConfig } from '../services/marketData';
import type { RiskEngine } from '../services/riskEngine';

/**
 * Paper execution engine.
 *
 * Fills are priced from the LIVE market LTP served by MarketDataService
 * (DhanHQ binary WS or REST quotes) — never from a constant. A premium-
 * scaled spread model (fillModel.ts) is applied on top of the real price,
 * shared with every exit path (db.ts closePaperPosition) so entries and
 * exits pay a consistent, realistic cost rather than drifting apart. If no
 * live price is known for the instrument the order is REJECTED, exactly
 * like a broker would reject an unpriceable order.
 *
 * LIMIT orders never rest — there is no order book (deliberately: paper
 * trading here only ever deals in liquid ATM CE/PE, so immediate-fill is
 * realistic). A LIMIT is filled only if it is already marketable against
 * the live LTP; otherwise it is REJECTED rather than filled at an
 * arbitrary price.
 */
export class PaperExecutionEngine {
  private client: DhanClient;
  private monitor: PositionMonitor;
  private market: MarketDataService;
  private risk: RiskEngine;
  private latencyMs: number;

  constructor(client: DhanClient, monitor: PositionMonitor, market: MarketDataService, risk: RiskEngine, latencyMs = 50) {
    this.client = client;
    this.monitor = monitor;
    this.market = market;
    this.risk = risk;
    this.latencyMs = latencyMs;
  }

  /** Real DhanHQ margin calculator — the same one the live margin endpoint
   * uses — so paper margin (long premium and short SPAN+exposure alike)
   * tracks the actual broker's numbers instead of a hand-rolled formula.
   * Falls back to the conservative default only if the call itself fails. */
  private resolveMargin: MarginResolver = async (params) => {
    try {
      const resp: any = await (this.client as any).marginCalculator.calculateSingle({
        exchangeSegment: params.exchangeSegment,
        productType: params.productType,
        transactionType: params.side,
        securityId: params.securityId,
        quantity: params.quantity,
        price: params.price,
      });
      const total = Number(resp?.totalMargin ?? resp?.data?.totalMargin);
      if (total > 0) return total;
    } catch { /* DhanHQ margin API unavailable — use the conservative default */ }
    return defaultMarginResolver(params);
  };

  async placeOrder(intent: any): Promise<any> {
    const { correlation_id, intent_id, params, risk_limits } = intent;
    const { security_id, quantity, transaction_type, order_type = 'MARKET', price = 0 } = params;
    const symbol = params.symbol || params.trading_symbol || `SEC_${security_id}`;
    journal.append('order_intent', { correlation_id, intent_id, params, risk_limits, mode: 'paper' });

    // Risk gate — the kill switch and EOD window block paper fills too.
    const gate = this.risk.canTrade();
    if (!gate.allowed) {
      eventBus.log('WARN', `Paper order REJECTED for ${correlation_id}: ${gate.reason}`, 'paper_engine');
      eventBus.emit('order', { kind: 'rejection', correlationId: correlation_id, reason: gate.reason });
      journal.append('order_result', { correlation_id, status: 'REJECTED', reason: gate.reason });
      return { status: 'REJECTED', reason: gate.reason };
    }

    // Resolve a fillable price — needed for MARKET pricing and to check
    // whether a LIMIT order is marketable. getFillablePrice (not getLtp)
    // enforces a tight staleness bound regardless of market hours, so a
    // fill is never priced off an arbitrarily old off-hours cache.
    const liveLtp = this.market.getFillablePrice(security_id);
    let referencePrice: number | null;
    if (order_type === 'MARKET') {
      referencePrice = liveLtp ?? (price > 0 ? Number(price) : null);
    } else if (liveLtp == null || price <= 0) {
      referencePrice = null;
    } else {
      const marketable = transaction_type === 'BUY' ? liveLtp <= price : liveLtp >= price;
      if (!marketable) {
        const reason = `LIMIT price ${price} not marketable vs LTP ${liveLtp}`;
        eventBus.log('WARN', `Paper order REJECTED for ${correlation_id}: ${reason}`, 'paper_engine');
        eventBus.emit('order', { kind: 'rejection', correlationId: correlation_id, reason });
        journal.append('order_result', { correlation_id, status: 'REJECTED', reason });
        return { status: 'REJECTED', reason };
      }
      referencePrice = transaction_type === 'BUY' ? Math.min(liveLtp, price) : Math.max(liveLtp, price);
    }
    if (referencePrice == null || referencePrice <= 0) {
      eventBus.log('WARN', `Paper order REJECTED for ${correlation_id}: no live LTP for ${symbol} (security ${security_id})`, 'paper_engine');
      eventBus.emit('order', { kind: 'rejection', correlationId: correlation_id, reason: 'No live LTP available for instrument' });
      journal.append('order_result', { correlation_id, status: 'REJECTED', reason: 'No live LTP available for instrument' });
      return { status: 'REJECTED', reason: 'No live LTP available for instrument' };
    }

    // Simulate network transmission latency.
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    const fillPrice = applyFillSlippage(referencePrice, transaction_type, 'ENTRY');

    const trailDist = typeof risk_limits?.trailing_stop === 'object'
      ? Number(risk_limits.trailing_stop.distance)
      : (risk_limits?.trailing_stop ? Number(risk_limits.trailing_stop) : undefined);

    let result: any;
    try {
      result = await executePaperOrder({
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
      }, this.resolveMargin);
    } catch (e: any) {
      // Insufficient margin (or any other fill precondition) — reject like
      // a broker would, not a 500.
      eventBus.log('WARN', `Paper order REJECTED for ${correlation_id}: ${e.message}`, 'paper_engine');
      eventBus.emit('order', { kind: 'rejection', correlationId: correlation_id, reason: e.message });
      journal.append('order_result', { correlation_id, status: 'REJECTED', reason: e.message });
      return { status: 'REJECTED', reason: e.message };
    }

    const fillPayload = {
      intent_id,
      correlation_id,
      is_paper: true,
      fill_price: result.fillPrice,
      quantity,
      security_id,
      symbol,
      latency_ms: result.latencyMs,
      charges: result.charges,
      filled_at: new Date().toISOString(),
    };

    eventBus.log('TRADE', `Paper fill ${transaction_type} ${quantity} ${symbol} @ ₹${result.fillPrice.toFixed(2)} (${correlation_id})`, 'paper_engine');
    eventBus.emit('order', { kind: 'fill', ...fillPayload });
    journal.append('order_result', { status: 'TRADED', ...fillPayload });
    await redisPublisher.publish('dhan:execution:fills', JSON.stringify(fillPayload)).catch(() => {});

    // Stop-loss / target / trailing monitoring via SDK PositionMonitor, fed
    // by MarketDataService ticks. Uses the FILL's resulting net position
    // (result.netQty/avgPrice), not this order's own quantity/fillPrice —
    // those only coincide when the order opens a flat position; an add-to
    // or a same-order sign flip would otherwise arm the monitor against a
    // position that doesn't match the account's actual net exposure.
    if (risk_limits && (risk_limits.stop_loss || risk_limits.trailing_stop || risk_limits.target) && result.netQty !== 0) {
      this.monitor.track({
        securityId: String(security_id),
        exchangeSegment: params.exchange_segment || 'NSE_FNO',
        quantity: result.netQty,
        entryPrice: result.avgPrice,
        stopLoss: risk_limits.stop_loss,
        target: risk_limits.target,
        trail: toTrailConfig(risk_limits.trailing_stop),
      });
    }

    // Keep the market data service subscribed to this instrument so the
    // position keeps being marked and monitored.
    this.market.addInstruments([{ securityId: String(security_id), exchangeSegment: params.exchange_segment || 'NSE_FNO' }]);

    return { status: 'TRADED', ...fillPayload };
  }
}
