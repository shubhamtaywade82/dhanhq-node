import type { DhanClient, OrderTracker, PositionMonitor } from '@nemesis-oss/dhanhq-sdk';
import { redisPublisher } from '../auth';
import { eventBus } from '../services/eventBus';
import { journal } from '../services/journal';
import type { MarketDataService } from '../services/marketData';
import { toTrailConfig } from '../services/marketData';
import type { RiskEngine } from '../services/riskEngine';
import type { PortfolioSource } from '../services/portfolioSource';

/**
 * Live execution engine — places REAL orders through DhanHQ v2.
 *
 * Order settlement uses the SDK's OrderTracker, which is fed by the
 * DhanHQ order-update WebSocket (connected once at boot by
 * MarketDataService). The register-before-place pattern ensures fast
 * fills are captured.
 */
export class LiveExecutionEngine {
  private client: DhanClient;
  private tracker: OrderTracker;
  private monitor: PositionMonitor;
  private market: MarketDataService;
  private risk: RiskEngine;
  private portfolio?: PortfolioSource;

  constructor(client: DhanClient, tracker: OrderTracker, monitor: PositionMonitor, market: MarketDataService, risk: RiskEngine, portfolio?: PortfolioSource) {
    this.client = client;
    this.tracker = tracker;
    this.monitor = monitor;
    this.market = market;
    this.risk = risk;
    this.portfolio = portfolio;
  }

  async placeOrder(intent: any): Promise<any> {
    const { correlation_id, intent_id, params, risk_limits } = intent;
    const { security_id, quantity, transaction_type, order_type = 'MARKET', exchange_segment = 'NSE_FNO', price = 0 } = params;
    journal.append('order_intent', { correlation_id, intent_id, params, risk_limits, mode: 'live' });

    // Risk gate — kill switch blocks live orders too.
    const gate = this.risk.canTrade();
    if (!gate.allowed) {
      eventBus.log('WARN', `Live order BLOCKED for ${correlation_id}: ${gate.reason}`, 'live_engine');
      eventBus.emit('order', { kind: 'rejection', correlationId: correlation_id, reason: gate.reason });
      journal.append('order_result', { correlation_id, status: 'REJECTED', reason: gate.reason });
      this.portfolio?.recordOrderOutcome({ status: 'REJECTED' });
      return { status: 'REJECTED', reason: gate.reason };
    }

    eventBus.log('TRADE', `Placing LIVE order ${transaction_type} ${quantity} × ${security_id} (${correlation_id})`, 'live_engine');

    // Register the waiter BEFORE placing — a fast fill can beat the HTTP response.
    const settled = this.tracker.waitFor(correlation_id, { timeoutMs: 30000 });

    await this.client.orders.place({
      correlationId: correlation_id,
      securityId: String(security_id),
      exchangeSegment: exchange_segment,
      transactionType: transaction_type,
      orderType: order_type,
      quantity,
      price,
      productType: params.product_type || 'INTRADAY',
    });

    let fill: any = null;
    try {
      fill = await settled;
    } catch (e: any) {
      // Timeout is not fatal — the order lives at the broker. Report pending.
      eventBus.log('WARN', `Order ${correlation_id} placed but settlement not observed yet (${e.message})`, 'live_engine');
      fill = { status: 'PENDING', filledQuantity: 0, averagePrice: price };
    }

    const fillPayload = {
      intent_id,
      correlation_id,
      is_paper: false,
      fill_price: fill.averagePrice || price,
      quantity: fill.filledQuantity || quantity,
      security_id,
      filled_at: new Date().toISOString(),
    };

    eventBus.emit('order', { kind: 'fill', ...fillPayload });
    journal.append('order_result', { status: fill.status || 'TRADED', ...fillPayload });
    this.portfolio?.recordOrderOutcome({ status: fill.status === 'REJECTED' ? 'REJECTED' : 'TRADED' });
    await redisPublisher.publish('dhan:execution:fills', JSON.stringify(fillPayload)).catch(() => {});

    if (risk_limits && (risk_limits.stop_loss || risk_limits.trailing_stop || risk_limits.target)) {
      this.monitor.track({
        securityId: String(security_id),
        exchangeSegment: exchange_segment,
        quantity: fill.filledQuantity || quantity,
        entryPrice: fill.averagePrice || price,
        stopLoss: risk_limits.stop_loss,
        target: risk_limits.target,
        trail: toTrailConfig(risk_limits.trailing_stop),
      });
    }

    this.market.addInstruments([{ securityId: String(security_id), exchangeSegment: exchange_segment }]);
    return fill;
  }
}
