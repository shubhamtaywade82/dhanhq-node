import { DhanClient, OrderTracker, type PositionMonitor } from '@nemesis-oss/dhanhq-sdk';
import { createDhanClient, redisPublisher, redisAvailable } from './auth';
import { initDatabase, listPaperPositions } from './db';
import { MarketDataService } from './services/marketData';
import { RiskEngine } from './services/riskEngine';
import { AutonomyEngine } from './services/autonomy';
import { AgentOrchestrator } from './services/agent';
import { SelfHealingService } from './services/selfHealing';
import { startTelegramNotifier } from './services/telegramNotifier';
import { eventBus } from './services/eventBus';
import { PaperExecutionEngine } from './engines/paper';
import { LiveExecutionEngine } from './engines/live';

/**
 * Core bootstrap — the autonomous trading stack, shared by every entry
 * point (HTTP server AND headless sidecar). The stack runs free of any
 * frontend: HTTP/WS is just one window onto it.
 */
export interface Core {
  client: DhanClient;
  market: MarketDataService;
  risk: RiskEngine;
  autonomy: AutonomyEngine;
  agent: AgentOrchestrator;
  paper: PaperExecutionEngine;
  live: LiveExecutionEngine;
  tracker: OrderTracker;
  selfHealing: SelfHealingService;
}

import { seedStandardStrategies } from './services/strategyConstructor';

export async function startCore(): Promise<Core> {
  await initDatabase();
  const client = await createDhanClient();

  const market = new MarketDataService(client);
  const risk = new RiskEngine(client, market);
  const autonomy = new AutonomyEngine(client, market, risk);

  // OrderTracker: resolve live orders to fills from order-update WS
  // events (MarketDataService re-emits them on the bus).
  const tracker = new OrderTracker();
  eventBus.on('order', (env) => {
    if (env.payload?.kind === 'order_update' && env.payload?.order) {
      try { tracker.onOrderUpdate(env.payload.order); } catch { /* defensive */ }
    }
  });

  const paper = new PaperExecutionEngine(client, market.monitor, market, risk);
  const live = new LiveExecutionEngine(client, tracker, market.monitor, market, risk);
  const agent = new AgentOrchestrator(client, market, risk, paper, live);
  autonomy.setAgent(agent);

  // Bridge core events into Redis pub/sub (Rails sidecar compat) when up.
  if (await redisAvailable()) {
    eventBus.setRedisSink(async (channel, message) => {
      await redisPublisher.publish(channel, message);
    });
  }

  const selfHealing = new SelfHealingService();
  selfHealing.start();
  startTelegramNotifier();

  await market.start();
  // risk/autonomy register their exit-signal and evaluation listeners here —
  // must happen BEFORE re-arming any existing position's stop-loss/target
  // below. Ticks start flowing the instant market.start() returns, and an
  // already-breached position can fire its exit signal within the first
  // tick; seedStandardStrategies does slow network calls, so starting these
  // after it (as before) left a real window where a fired exit signal had
  // no listener yet and was silently lost.
  await risk.start();
  await autonomy.start();
  await seedExistingPositions(market, market.monitor);
  await seedStandardStrategies(client, market, paper);

  eventBus.emit('system', { type: 'boot', mode: process.env.TRADING_MODE || 'paper' });
  eventBus.log('SYSTEM', `Core stack online (mode=${process.env.TRADING_MODE || 'paper'}) — backend is autonomous; frontend optional`, 'core');

  return { client, market, risk, autonomy, agent, paper, live, tracker, selfHealing };
}

/** Re-subscribes quotes AND re-arms stop-loss/target for positions that
 * were already open before this boot — PositionMonitor's tracked-positions
 * list lives in process memory, so a restart otherwise silently drops SL/
 * target protection on every surviving position until it's manually reset. */
async function seedExistingPositions(market: MarketDataService, monitor: PositionMonitor): Promise<void> {
  try {
    const positions = await listPaperPositions();
    const open = positions.filter((p) => p.netQty !== 0 && p.securityId && p.securityId !== '0');
    const active = open.map((p) => ({ securityId: String(p.securityId), exchangeSegment: p.exchangeSegment || 'NSE_FNO' }));
    if (active.length > 0) market.addInstruments(active);

    for (const p of open) {
      if (!p.stopLoss && !p.target) continue;
      monitor.track({
        securityId: String(p.securityId),
        exchangeSegment: p.exchangeSegment || 'NSE_FNO',
        quantity: p.netQty,
        entryPrice: p.netQty > 0 ? p.buyAvg : p.sellAvg,
        stopLoss: p.stopLoss ?? undefined,
        target: p.target ?? undefined,
      });
    }
  } catch { /* non-fatal */ }
}
