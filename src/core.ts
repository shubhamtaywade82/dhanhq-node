import { DhanClient, OrderTracker, type PositionMonitor } from '@nemesis-oss/dhanhq-sdk';
import { createDhanClient, redisPublisher, redisAvailable } from './auth';
import { initDatabase, listPaperPositions } from './db';
import { MarketDataService, toTrailConfig } from './services/marketData';
import { RiskEngine } from './services/riskEngine';
import { AutonomyEngine } from './services/autonomy';
import { AgentOrchestrator } from './services/agent';
import { SelfHealingService } from './services/selfHealing';
import { startTelegramNotifier } from './services/telegramNotifier';
import { eventBus } from './services/eventBus';
import { PaperExecutionEngine } from './engines/paper';
import { LiveExecutionEngine } from './engines/live';
import { marketClock } from './services/marketHours';
import { hasHolidayCoverage } from './services/holidays';
import { journal } from './services/journal';

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
  // LiveExecutionEngine places real broker orders but writes no position/
  // wallet state of its own — RiskEngine, AutonomyEngine, the kill switch
  // and EOD square-off all read/act on the PAPER tables regardless of
  // TRADING_MODE. In live mode that means real capital trades with the
  // entire risk layer blind to it: the daily-loss breaker sees ₹0, EOD
  // square-off closes paper positions while real ones stay open, and the
  // kill switch's "positions closed" count is fabricated from an empty
  // paper book. Refusing to boot is safer than an unmonitored live book —
  // this must be resolved (a real PortfolioSource behind risk/autonomy)
  // before TRADING_MODE=live is usable again.
  if (process.env.TRADING_MODE === 'live') {
    throw new Error(
      'TRADING_MODE=live is currently unsafe: risk engine, autonomy loop, EOD square-off, and the kill switch ' +
      'all operate on paper position/wallet state, not the live broker book. Live orders would execute ' +
      'completely unmonitored. Set TRADING_MODE=paper until a live PortfolioSource is wired through.'
    );
  }
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

  // The holiday table is hand-maintained per calendar year (see holidays.ts)
  // — running into an uncovered year would silently treat every day as
  // tradeable again, which is exactly the bug this table exists to close.
  // Loud at boot, not a per-cycle log spam source.
  const todayIst = marketClock().istDate;
  if (!hasHolidayCoverage(todayIst)) {
    eventBus.log('ERROR', `No trading-holiday data for ${todayIst.slice(0, 4)} — market-closed days will NOT be detected. Update src/services/holidays.ts.`, 'core');
  }

  // Durable audit trail — order intents/results, risk/kill decisions, EOD
  // square-offs, control commands (journal.ts). Opened before anything can
  // journal to it; a prior boot's entries from the same trading day (a
  // restart) are read back for a diagnostic count, not replayed into state.
  const priorEntries = journal.open(todayIst);
  eventBus.log('SYSTEM', `Journal opened for ${todayIst} (${priorEntries.length} entr${priorEntries.length === 1 ? 'y' : 'ies'} from earlier this session)`, 'core');

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
      if (!p.stopLoss && !p.target && !p.trailingStop) continue;
      monitor.track({
        securityId: String(p.securityId),
        exchangeSegment: p.exchangeSegment || 'NSE_FNO',
        quantity: p.netQty,
        entryPrice: p.netQty > 0 ? p.buyAvg : p.sellAvg,
        stopLoss: p.stopLoss ?? undefined,
        target: p.target ?? undefined,
        trail: toTrailConfig(p.trailingStop),
      });
    }
  } catch { /* non-fatal */ }
}
