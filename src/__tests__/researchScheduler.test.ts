import { ResearchScheduler } from '../services/research/researchScheduler';
import { saveWatchlist, clearWatchlistForTests } from '../services/research/researchRepository';

describe('ResearchScheduler — Autonomous Market Lifecycle Intelligence', () => {
  let scheduler: ResearchScheduler;
  let mockOrchestrator: any;

  beforeEach(async () => {
    await clearWatchlistForTests();
    mockOrchestrator = {
      screen: jest.fn().mockResolvedValue({
        universe: 'FNO_HEAVYWEIGHTS',
        preset: 'QUALITY_COMPOUNDERS',
        totalScreened: 10,
        totalPassed: 3,
        candidates: [{ symbol: 'RELIANCE', passed: true, deterministicScore: 85, name: 'Reliance', sector: 'Energy', metrics: { rsi14: 50, supertrend: 'BULLISH', cfoVsPat: 1.1, roicPct: 15, debtToEquity: 0.4, dcfMarginOfSafetyPct: 12 } }],
        topPicks: ['RELIANCE'],
      }),
      analyze: jest.fn().mockResolvedValue({
        symbol: 'RELIANCE',
        verdict: { stance: 'HOLD', qualityScore: 80, valuationScore: 65, fairValue: { base: 1440 }, marginOfSafetyPct: 12, keyCatalysts: ['Retail growth'] },
      }),
      getSignal: jest.fn().mockReturnValue({
        symbol: 'RELIANCE',
        bias: 'BULLISH',
        conviction: 75,
        horizon: 'SWING',
        suggestedStructures: ['BULL_CALL_SPREAD'],
      }),
    };

    await saveWatchlist([{
      symbol: 'RELIANCE',
      name: 'Reliance Industries',
      sector: 'Energy',
      securityId: '2885',
      cmp: 1300,
      deterministicScore: 88,
      passed: true,
      passedRules: [],
      failedRules: [],
      metrics: { rsi14: 50, supertrend: 'BULLISH', cfoVsPat: 1.1, roicPct: 15, debtToEquity: 0.4, dcfMarginOfSafetyPct: 12 },
    }], 'FNO_HEAVYWEIGHTS');

    scheduler = new ResearchScheduler(mockOrchestrator);
  });

  afterEach(() => {
    scheduler.stop();
  });

  it('reports initial scheduler status and market phase', () => {
    const status = scheduler.getStatus();
    expect(status.enabled).toBe(true);
    expect(['PRE_MARKET', 'MARKET_HOURS', 'POST_MARKET', 'CLOSED']).toContain(status.marketPhase);
    expect(status.nextScheduledJob).toBeDefined();
  });

  it('executes pre-market briefing phase', async () => {
    const res = await scheduler.runPreMarketBrief();
    expect(res).toContain('PRE-MARKET INSTITUTIONAL BRIEFING');
    expect(res).toContain('RELIANCE');
  });

  it('executes post-market EOD dossier phase', async () => {
    const res = await scheduler.runPostMarketDossier();
    expect(res).toContain('POST-MARKET INSTITUTIONAL DOSSIER');
    expect(res).toContain('RELIANCE');
    expect(mockOrchestrator.analyze).toHaveBeenCalledWith('RELIANCE');
  });

  it('triggers specific phases via triggerPhase()', async () => {
    const res = await scheduler.triggerPhase('pre_market');
    expect(res.result).toContain('PRE-MARKET');

    const monthly = await scheduler.triggerPhase('monthly_screen');
    expect(monthly.result).toContain('completed');
  });
});
