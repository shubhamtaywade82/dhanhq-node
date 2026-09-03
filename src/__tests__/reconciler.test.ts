import { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { AutonomyEngine } from '../services/autonomy';
import { RiskEngine } from '../services/riskEngine';
import { MarketDataService, toTrailConfig } from '../services/marketData';
import { initDatabase, executePaperOrder, resetPaperWallet } from '../db';
import * as db from '../db';

function stubClient(): DhanClient {
  return new DhanClient({ clientId: 'test', token: 'test' });
}

describe('AutonomyEngine — monitor/position reconciler', () => {
  beforeAll(async () => { await initDatabase(); });
  // mem.positions is a shared module-level ledger — without this, a
  // still-open position from an earlier test in this file would leak into
  // a later test's reconcileMonitor() call via listPaperPositions().
  beforeEach(async () => { await resetPaperWallet(100000); });
  afterEach(() => jest.restoreAllMocks());

  function setup() {
    const client = stubClient();
    const market = new MarketDataService(client);
    const risk = new RiskEngine(client, market);
    const autonomy = new AutonomyEngine(client, market, risk);
    return { market, autonomy };
  }

  it('re-arms missing protection (including trailing stop) for an open position the monitor lost track of', async () => {
    const { market, autonomy } = setup();
    await executePaperOrder({
      symbol: 'RECON_MISSING', securityId: '55001', quantity: 50,
      transactionType: 'BUY', price: 100,
      stopLoss: 80, target: 150, trailingStop: 10,
    });
    expect(market.monitor.tracked().find((t) => t.securityId === '55001')).toBeUndefined();

    const alertSpy = jest.spyOn(db, 'pushAlert');
    await (autonomy as any).reconcileMonitor();

    const rearmed = market.monitor.tracked().find((t) => t.securityId === '55001');
    expect(rearmed).toBeDefined();
    expect(rearmed?.exchangeSegment).toBe('NSE_FNO');
    expect(rearmed?.stopLoss).toBe(80);
    expect(rearmed?.target).toBe(150);
    expect(rearmed?.trail).toEqual(toTrailConfig(10)); // NOT the raw 10 — the SDK-correct shape
    expect(alertSpy).toHaveBeenCalledWith('WARN', 'autonomy', expect.stringContaining('re-armed'));
  });

  it('untracks a monitor entry that has no matching open position', async () => {
    const { market, autonomy } = setup();
    // Tracked directly, with NO corresponding position in the ledger —
    // simulates a stale entry left behind by a close path that failed to
    // untrack (or a prior trade on this security that has since closed).
    market.monitor.track({
      securityId: '55002', exchangeSegment: 'NSE_FNO',
      quantity: 50, entryPrice: 100, stopLoss: 80,
    });
    expect(market.monitor.tracked().find((t) => t.securityId === '55002')).toBeDefined();

    const alertSpy = jest.spyOn(db, 'pushAlert');
    await (autonomy as any).reconcileMonitor();

    expect(market.monitor.tracked().find((t) => t.securityId === '55002')).toBeUndefined();
    expect(alertSpy).toHaveBeenCalledWith('WARN', 'autonomy', expect.stringContaining('untracked'));
  });

  it('does nothing — no correction, no alert — when the monitor and ledger already agree', async () => {
    const { market, autonomy } = setup();
    await executePaperOrder({
      symbol: 'RECON_OK', securityId: '55003', quantity: 50,
      transactionType: 'BUY', price: 100, stopLoss: 80,
    });
    market.monitor.track({
      securityId: '55003', exchangeSegment: 'NSE_FNO',
      quantity: 50, entryPrice: 100, stopLoss: 80,
    });

    const alertSpy = jest.spyOn(db, 'pushAlert');
    await (autonomy as any).reconcileMonitor();

    expect(market.monitor.tracked().filter((t) => t.securityId === '55003').length).toBe(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('leaves an unprotected open position (no stop/target/trail configured) untracked — nothing to reconcile', async () => {
    const { market, autonomy } = setup();
    await executePaperOrder({
      symbol: 'RECON_NAKED', securityId: '55004', quantity: 50,
      transactionType: 'BUY', price: 100,
    });

    const alertSpy = jest.spyOn(db, 'pushAlert');
    await (autonomy as any).reconcileMonitor();

    expect(market.monitor.tracked().find((t) => t.securityId === '55004')).toBeUndefined();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
