import { saveScreenerRun, saveWatchlist, getActiveWatchlist, updateWatchlistAnalyzed } from '../services/research/researchRepository';
import { type ScreenerCandidate, type ScreenerResult } from '../services/research/types';

describe('ResearchRepository — Durable DB & Memory Persistence', () => {
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
    metrics: {
      rsi14: 52,
      supertrend: 'BULLISH',
      cfoVsPat: 1.05,
      roicPct: 28,
      debtToEquity: 0.25,
      dcfMarginOfSafetyPct: 15,
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
      preset: 'QUALITY_COMPOUNDERS',
      totalScreened: 10,
      totalPassed: 5,
      candidates: [mockCandidate],
      topPicks: ['TCS'],
      screenedAt: Date.now(),
    };

    await expect(saveScreenerRun(run)).resolves.not.toThrow();
  });
});
