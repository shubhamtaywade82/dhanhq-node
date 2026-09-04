import { saveScreenerRun, saveWatchlist, getActiveWatchlist, updateWatchlistAnalyzed } from '../services/research/researchRepository';
import { type ScreenerCandidate, type ScreenerResult } from '../services/research/types';
import { dbMode } from '../db';

describe('ResearchRepository — Durable DB & Memory Persistence', () => {
  // This suite writes via saveWatchlist/saveScreenerRun without ever calling
  // initDatabase(). Found live: that reached the real dev database and
  // overwrote the operator's research watchlist on every `npx jest` run —
  // the whole live watchlist was this file's TCS fixture plus the
  // scheduler suite's RELIANCE one.
  it('never writes to Postgres from the test environment', () => {
    expect(dbMode()).toBe('memory');
  });

  const mockCandidate: ScreenerCandidate = {
    symbol: 'TCS',
    name: 'Tata Consultancy Services',
    sector: 'Information Technology',
    securityId: '11536',
    cmp: 2300,
    deterministicScore: 92,
    passed: true,
    passedRules: ['ROIC >= 12%'],
    failedRules: [],
    exchangeSegment: 'NSE_EQ',
    horizons: ['SWING', 'LONG_TERM'],
    metrics: {
      close: 2300, return20d: 4.2, return60d: 11.5, return250d: 32.0,
      sma20: 2250, sma50: 2180, sma200: 2000, sma200Rising: true,
      high52w: 2400, low52w: 1700, pctFrom52wHigh: -4.2, volatilityPct: 1.3,
      avgTradedValue: 8_00_00_000, relativeStrength60d: 6.4, relativeStrength250d: 14.2,
      candleCount: 300,
    },
  };

  it('saves and retrieves active watchlist items', async () => {
    await saveWatchlist([mockCandidate], 'FNO_HEAVYWEIGHTS');
    const items = await getActiveWatchlist();

    expect(items.length).toBeGreaterThan(0);
    const tcs = items.find((i) => i.symbol === 'TCS');
    expect(tcs).toBeDefined();
    expect(tcs!.deterministicScore).toBe(92);
    expect(tcs!.status).toBe('ACTIVE');
    expect(tcs!.expiresAt).toBeGreaterThan(Date.now());
  });

  it('updates last analyzed timestamp', async () => {
    await updateWatchlistAnalyzed('TCS');
    const items = await getActiveWatchlist();
    const tcs = items.find((i) => i.symbol === 'TCS');
    expect(tcs?.lastAnalyzedAt).toBeDefined();
  });

  it('saves screener run into history', async () => {
    const run: ScreenerResult = {
      universe: 'FNO_HEAVYWEIGHTS',
      exchange: 'NSE',
      preset: 'QUALITY_COMPOUNDERS',
      totalScreened: 10,
      totalPassed: 5,
      skipped: 0,
      candidates: [mockCandidate],
      topPicks: ['TCS'],
      screenedAt: Date.now(),
    };

    await expect(saveScreenerRun(run)).resolves.not.toThrow();
  });
});
