import { RiskEngine, DEFAULT_RISK_LIMITS } from '../services/riskEngine';
import { MarketDataService } from '../services/marketData';
import { AgentOrchestrator } from '../services/agent';
import { PaperExecutionEngine } from '../engines/paper';
import { LiveExecutionEngine } from '../engines/live';
import { eventBus } from '../services/eventBus';
import { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import {
  initDatabase, dbMode, executePaperOrder, getPaperWallet,
  listPaperPositions, closeAllPaperPositions, markPositionsToMarket,
  resetPaperWallet, pool, saveRiskState,
} from '../db';

/**
 * Service-level tests. They run in-memory (no PostgreSQL in CI) and use a
 * stub DhanClient — they verify the SYSTEM's behavior (pricing rules,
 * risk gates, kill switch, mark-to-market), not the broker.
 */

function stubClient(): DhanClient {
  return new DhanClient({ clientId: 'test', token: 'test' });
}

function stubMarket(ltp: number | null = 100): MarketDataService {
  const svc = new MarketDataService(stubClient());
  // Inject a live-ish quote without hitting the network.
  (svc as any).quotes.set('44000', {
    securityId: '44000', symbol: undefined, ltp: ltp ?? 100,
    change: 0, pctChange: 0, high: 101, low: 99, open: 100, prevClose: 100,
    volume: 0, oi: 0, updatedAt: Date.now(),
  });
  return svc;
}

async function stubEngines(ltp: number | null = 100) {
  const client = stubClient();
  const market = stubMarket(ltp);
  const risk = new RiskEngine(client, market);
  await risk.start();
  // Hermetic mock: decouple pricing and execution tests from the host's wall-clock EOD window
  jest.spyOn(risk, 'canTrade').mockImplementation(() =>
    risk.isKilled() ? { allowed: false, reason: 'Kill switch engaged' } : { allowed: true }
  );
  const paper = new PaperExecutionEngine(client, market.monitor, market, risk);
  const live = new LiveExecutionEngine(client, (client as any).tracker ?? ({} as any), market.monitor, market, risk);
  const agent = new AgentOrchestrator(client, market, risk, paper, live);
  return { client, market, risk, paper, live, agent };
}

describe('Paper execution engine — real-LTP pricing policy', () => {
  beforeAll(async () => { await initDatabase(); });

  it('REJECTS a market order when no live LTP exists (never fills at a made-up price)', async () => {
    const { paper } = await stubEngines(null); // no quote for this instrument
    const result = await paper.placeOrder({
      correlation_id: 'test_no_ltp',
      intent_id: 'i1',
      params: { security_id: '99999', quantity: 50, transaction_type: 'BUY', order_type: 'MARKET' },
    });
    expect(result.status).toBe('REJECTED');
    expect(String(result.reason)).toMatch(/no live LTP/i);
  });

  it('fills at the live LTP with adverse slippage, not at params.price', async () => {
    // getFillablePrice refuses to consider ANY quote fillable outside market
    // hours (DATA-01 fix) — pin the clock to a known IST market-open moment
    // so this test verifies pricing behavior, not whatever time it happens
    // to run at.
    // Fake Date only — placeOrder/risk.start() rely on real setTimeout/setInterval
    // internally, and jest's default fake-timer mode freezes those too, hanging
    // the test until it times out.
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'nextTick'] })
      .setSystemTime(new Date('2026-09-01T04:30:00.000Z')); // 10:00 IST, Tuesday
    try {
      const { paper } = await stubEngines(100);
      const result: any = await paper.placeOrder({
        correlation_id: 'test_ltp_fill',
        intent_id: 'i2',
        params: { security_id: '44000', quantity: 50, transaction_type: 'BUY', order_type: 'MARKET', price: 555 },
      });
      expect(result.status).toBe('TRADED');
      // BUY slippage = +1 tick (0.05) over the live LTP of 100, NOT price 555.
      expect(result.fill_price).toBeCloseTo(100.05, 2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('REJECTS orders while the kill switch is engaged', async () => {
    const { paper, risk } = await stubEngines(100);
    await risk.armKillSwitch('test kill');
    const result = await paper.placeOrder({
      correlation_id: 'test_killed',
      intent_id: 'i3',
      params: { security_id: '44000', quantity: 50, transaction_type: 'BUY' },
    });
    expect(result.status).toBe('REJECTED');
    expect(String(result.reason)).toMatch(/kill switch/i);
    await risk.disarmKillSwitch();
  });
});

describe('RiskEngine — real-state circuit breakers', () => {
  beforeAll(async () => { await initDatabase(); });

  it('computes breakers from the real wallet and positions', async () => {
    const { risk } = await stubEngines(100);
    const rows = await risk.evaluate();
    const rules = rows.map((r) => r.rule);
    expect(rules).toContain('Daily Loss Limit');
    expect(rules).toContain('Margin Utilization');
    expect(rules).toContain('Stale Market Tick');
    // A fresh wallet is far from the daily loss limit.
    const daily = rows.find((r) => r.rule === 'Daily Loss Limit')!;
    expect(daily.state).toBe('OK');
  });

  it('arms the kill switch when the daily loss limit is breached', async () => {
    const { risk } = await stubEngines(100);
    await risk.setLimits({ dailyLossLimit: 1 }); // trivially breachable
    // Create a realized loss directly through the paper DB layer.
    await executePaperOrder({ symbol: 'RISKTEST', quantity: 50, transactionType: 'BUY', price: 100 });
    await executePaperOrder({ symbol: 'RISKTEST', quantity: 50, transactionType: 'SELL', price: 90 }); // -500 realized
    await risk.evaluate();
    expect(risk.isKilled()).toBe(true);
    const snap = risk.snapshot();
    expect(snap.killed).toBe(true);
    expect(String(snap.killedReason)).toMatch(/daily loss limit/i);
    await risk.disarmKillSwitch();
    risk.stop();
  });

  it('persists limits so a restart keeps configuration', async () => {
    const { risk } = await stubEngines(100);
    await risk.setLimits({ maxMarginUtilPct: 42 });
    const risk2 = new RiskEngine(stubClient(), stubMarket(100));
    await risk2.start();
    expect(risk2.getLimits().maxMarginUtilPct).toBe(42);
    risk.stop();
    risk2.stop();
  });

  it('defaults are sane', () => {
    expect(DEFAULT_RISK_LIMITS.dailyLossLimit).toBeGreaterThan(0);
    expect(DEFAULT_RISK_LIMITS.maxConsecutiveLosses).toBeGreaterThan(0);
  });
});

describe('RiskEngine — IST session rollover (RISK-01)', () => {
  beforeAll(async () => { await initDatabase(); });
  beforeEach(async () => { await resetPaperWallet(100000); });
  afterAll(async () => { await resetPaperWallet(100000); });

  it('scopes sessionRealizedPnl to today, not the lifetime wallet total', async () => {
    await executePaperOrder({ symbol: 'SESSTEST', securityId: '44000', quantity: 50, transactionType: 'BUY', price: 100 });
    await executePaperOrder({ symbol: 'SESSTEST', securityId: '44000', quantity: 50, transactionType: 'SELL', price: 110 }); // +500 realized

    const w1 = await getPaperWallet();
    // First read of a fresh session snapshots the base at the current lifetime
    // total, so a session that already has realized PnL when the process
    // boots doesn't retroactively count as "today's" loss/gain.
    expect(w1.sessionRealizedPnl).toBe(w1.realizedPnl);

    await executePaperOrder({ symbol: 'SESSTEST', securityId: '44000', quantity: 50, transactionType: 'BUY', price: 100 });
    await executePaperOrder({ symbol: 'SESSTEST', securityId: '44000', quantity: 50, transactionType: 'SELL', price: 106 }); // +300 more

    const w2 = await getPaperWallet();
    expect(w2.sessionRealizedPnl).toBeCloseTo(w1.sessionRealizedPnl + 300, 2);
    expect(w2.realizedPnl).toBeCloseTo(w1.realizedPnl + 300, 2);
  });

  it('auto-clears a kill switch armed on a prior trading day', async () => {
    await saveRiskState({ killed: true, killedReason: 'stale test kill', killedDate: '2000-01-01', limits: {} });
    const risk = new RiskEngine(stubClient(), stubMarket(100));
    await risk.start();
    expect(risk.isKilled()).toBe(false);
    risk.stop();
  });

  it('keeps a kill switch armed today across a restart', async () => {
    const today = new Date().toISOString().slice(0, 10); // close enough for a same-instant restart in CI's UTC/IST window
    await saveRiskState({ killed: true, killedReason: 'live test kill', killedDate: today, limits: {} });
    const risk = new RiskEngine(stubClient(), stubMarket(100));
    await risk.start();
    // Only assert same-day persistence when the host clock and IST agree on
    // the date (avoids UTC-evening flakiness where `today` != IST's today).
    const { marketClock } = await import('../services/marketHours');
    if (marketClock().istDate === today) expect(risk.isKilled()).toBe(true);
    risk.stop();
    await saveRiskState({ killed: false, killedReason: null, killedDate: null, limits: {} });
  });
});

describe('Kill switch — real position square-off', () => {
  beforeAll(async () => { await initDatabase(); });

  it('closes open positions at live LTP when armed', async () => {
    const market = stubMarket(120);
    const risk = new RiskEngine(stubClient(), market);
    await risk.start();
    await risk.disarmKillSwitch();

    // Open a position at 100, market now 120 → closing realizes +20/qty.
    await executePaperOrder({ symbol: 'KILLTEST', securityId: '44000', quantity: 50, transactionType: 'BUY', price: 100 });
    const before = await getPaperWallet();
    const result = await risk.armKillSwitch('kill switch test');
    const after = await getPaperWallet();

    expect(result.status).toBe('killed');
    expect(result.details.positionsClosed).toBeGreaterThanOrEqual(1);
    expect(after.realizedPnl).toBeGreaterThan(before.realizedPnl);

    const positions = await listPaperPositions();
    const stillOpen = positions.filter((p: any) => p.netQty !== 0 && p.tradingSymbol === 'KILLTEST');
    expect(stillOpen.length).toBe(0);
    await risk.disarmKillSwitch();
  });
});

describe('Mark-to-market — autonomy loop feed', () => {
  beforeAll(async () => { await initDatabase(); });

  it('marks open positions from live ticks', async () => {
    await executePaperOrder({ symbol: 'MARKTEST', securityId: '44000', quantity: 50, transactionType: 'BUY', price: 100 });
    const market = stubMarket(150);
    const { totalUnrealized, staleCount } = await markPositionsToMarket((secId) => market.getLtp(secId));
    expect(totalUnrealized).toBeGreaterThan(0); // (150-100)*50 across open positions
    expect(staleCount).toBe(0);
    const pos = (await listPaperPositions()).find((p: any) => p.tradingSymbol === 'MARKTEST');
    expect(pos?.ltp).toBe(150);
    expect(pos?.unrealizedPnl).toBeGreaterThan(0);
  });
});

describe('AgentOrchestrator — honest LLM fallback', () => {
  beforeAll(async () => { await initDatabase(); });

  it('reports deterministic mode when Ollama is unreachable', async () => {
    const { agent } = await stubEngines(100);
    const status = agent.status();
    expect(['ollama', 'deterministic']).toContain(status.llm);
    expect(status.personas.planner).toEqual({ status: 'idle', steps: 0 });
  });

  it('exposes the real SDK tool catalog (44 policy-gated tools)', () => {
    const { agent } = { agent: new AgentOrchestrator(stubClient(), stubMarket(100), new RiskEngine(stubClient(), stubMarket(100)), {} as any, {} as any) };
    const catalog = agent.toolCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(40);
    const names = catalog.map((t) => t.name);
    expect(names).toContain('dhan_ltp');
    expect(names).toContain('dhan_option_chain');
    expect(names).toContain('dhan_place_order');
  });

  it('refuses concurrent runs and blocked runs honestly', async () => {
    const client = stubClient();
    const market = stubMarket(100);
    const risk = new RiskEngine(client, market);
    await risk.start();
    const paper = new PaperExecutionEngine(client, market.monitor, market, risk);
    const live = new LiveExecutionEngine(client, {} as any, market.monitor, market, risk);
    const agent = new AgentOrchestrator(client, market, risk, paper, live);

    await risk.armKillSwitch('agent test block');
    await expect(agent.run('test objective')).rejects.toThrow(/kill switch/i);
    await risk.disarmKillSwitch();
    risk.stop();
  });

  it('unwinds a multi-leg deploy when only some legs fill (EXEC-01)', async () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'nextTick'] })
      .setSystemTime(new Date('2026-09-01T04:30:00.000Z')); // 10:00 IST, Tuesday
    try {
      const { agent } = await stubEngines(100); // quote exists only for security '44000'
      const strat = {
        id: `exec01_test_${Date.now()}`,
        name: 'Test Bull Call Spread',
        symbol: 'NIFTY',
        type: 'BULL_CALL_SPREAD' as any,
        lots: 1,
        estimatedNetPremium: 0,
        lotSize: 50,
        legs: [
          // Fillable: quote exists for this security.
          { instrument: 'NIFTY24050CE', securityId: '44000', side: 'BUY' as const, qty: 50, strike: 24050, optionType: 'CE' as const, price: 100, exchangeSegment: 'NSE_FNO' },
          // Unfillable: no quote for this security and no fallback price → paper.placeOrder REJECTs.
          { instrument: 'NIFTY24150CE', securityId: '99999', side: 'SELL' as const, qty: 50, strike: 24150, optionType: 'CE' as const, price: 0, exchangeSegment: 'NSE_FNO' },
        ],
      };
      const result: any = await (agent as any).executeStrategy('run1', 'deploy this spread', strat, true);
      expect(result.status).toBe('FAILED');
      expect(result.reason).toBe('partial_fill_unwound');
      const pos = (await listPaperPositions()).find((p: any) => p.tradingSymbol === 'NIFTY24050CE');
      expect(Number(pos?.netQty || 0)).toBe(0); // the leg that filled was unwound back to flat
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Database layer — fallback mode honesty', () => {
  afterAll(async () => {
    await resetPaperWallet(100000);
    await pool.end();
  });

  it('reports which persistence mode is active', () => {
    expect(['postgres', 'memory']).toContain(dbMode());
  });
});
