import { DhanClient, OrderTracker } from '@nemesis-oss/dhanhq-sdk';
import { createDhanClient, redisPublisher, redisAvailable } from './auth';
import { initDatabase, listPaperPositions } from './db';
import { MarketDataService } from './services/marketData';
import { RiskEngine } from './services/riskEngine';
import { AutonomyEngine } from './services/autonomy';
import { AgentOrchestrator } from './services/agent';
import { SelfHealingService } from './services/selfHealing';
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
  if (redisAvailable()) {
    eventBus.setRedisSink(async (channel, message) => {
      await redisPublisher.publish(channel, message);
    });
  }

  const selfHealing = new SelfHealingService();
  selfHealing.start();

  await market.start();
  await seedExistingPositions(market);
  await risk.start();
  await autonomy.start();

  eventBus.emit('system', { type: 'boot', mode: process.env.TRADING_MODE || 'paper' });
  eventBus.log('SYSTEM', `Core stack online (mode=${process.env.TRADING_MODE || 'paper'}) — backend is autonomous; frontend optional`, 'core');

  return { client, market, risk, autonomy, agent, paper, live, tracker, selfHealing };
}

async function seedExistingPositions(market: MarketDataService): Promise<void> {
  try {
    const positions = await listPaperPositions();
    const active = positions
      .filter((p) => p.netQty !== 0 && p.securityId && p.securityId !== '0')
      .map((p) => ({ securityId: String(p.securityId), exchangeSegment: p.exchangeSegment || 'NSE_FNO' }));
    if (active.length > 0) market.addInstruments(active);
  } catch { /* non-fatal */ }
}
