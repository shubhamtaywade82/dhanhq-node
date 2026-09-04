import { ResearchOrchestrator } from '../services/research/researchOrchestrator';
import { MarketDataService } from '../services/marketData';
import { eventBus } from '../services/eventBus';
import { initDatabase } from '../db';

describe('ResearchOrchestrator', () => {
  let mockClient: any;
  let mockMarket: any;
  let orchestrator: ResearchOrchestrator;

  beforeAll(async () => {
    await initDatabase();
  });

  // The screener needs a scrip master to resolve ids against and ~250
  // sessions of history to judge a trend over; six bars is below its
  // minimum and is reported as skipped rather than scored.
  const uptrend = (n: number, start: number, dailyPct: number) => {
    const close: number[] = [];
    let price = start;
    for (let i = 0; i < n; i++) { price *= 1 + dailyPct / 100; close.push(price); }
    return {
      close,
      high: close.map((c) => c * 1.01),
      low: close.map((c) => c * 0.99),
      volume: close.map(() => 500000),
    };
  };

  beforeEach(() => {
    mockClient = {
      marketFeed: {
        quote: jest.fn().mockResolvedValue({ data: { NSE_EQ: { '2885': { ltp: 1350, volume: 500000, close: 1340 } } } }),
      },
      charts: {
        historical: jest.fn().mockResolvedValue(uptrend(300, 1000, 0.3)),
      },
      instruments: {
        bySegment: jest.fn(async (seg: string) => (seg === 'NSE_FNO' ? [] : [
          { securityId: '2885', underlyingSymbol: 'RELIANCE', displayName: 'Reliance Industries', series: 'EQ' },
          { securityId: '11536', underlyingSymbol: 'TCS', displayName: 'Tata Consultancy Services', series: 'EQ' },
          { securityId: '1594', underlyingSymbol: 'INFY', displayName: 'Infosys', series: 'EQ' },
          { securityId: '7229', underlyingSymbol: 'HCLTECH', displayName: 'HCL Technologies', series: 'EQ' },
          { securityId: '13538', underlyingSymbol: 'TECHM', displayName: 'Tech Mahindra', series: 'EQ' },
          { securityId: '3787', underlyingSymbol: 'WIPRO', displayName: 'Wipro', series: 'EQ' },
        ])),
      },
    };

    mockMarket = {
      getLtp: jest.fn().mockReturnValue(1350),
      stats: jest.fn().mockReturnValue({ source: 'ws' }),
    };

    orchestrator = new ResearchOrchestrator(mockClient, mockMarket as unknown as MarketDataService, undefined, null);
  });

  it('executes end-to-end research run and produces complete verdict', async () => {
    const telemetryEvents: any[] = [];
    const unsubscribe = eventBus.on('telemetry', (ev) => {
      if (typeof ev.payload?.summary === 'string' && ev.payload.summary.includes('RESEARCH')) {
        telemetryEvents.push(ev.payload);
      }
    });

    const run = await orchestrator.analyze('RELIANCE');

    unsubscribe();

    expect(run.status).toBe('COMPLETED');
    expect(run.symbol).toBe('RELIANCE');
    expect(run.evidenceCount).toBeGreaterThan(0);
    expect(run.verdict).toBeDefined();
    expect(run.verdict?.fairValue.base).toBeGreaterThan(0);
    expect(['BUY', 'HOLD', 'AVOID']).toContain(run.verdict?.stance);
    expect(telemetryEvents.length).toBeGreaterThanOrEqual(3);
  });

  it('stores and retrieves research runs and evidence trails', async () => {
    const run = await orchestrator.analyze('TCS');
    const fetched = await orchestrator.getRun(run.runId);

    expect(fetched).toBeDefined();
    expect(fetched?.symbol).toBe('TCS');
    expect(fetched?.status).toBe('COMPLETED');

    const evidence = await orchestrator.getEvidence(run.runId);
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0].claim).toBeDefined();

    const runsList = await orchestrator.listRuns(10);
    expect(runsList.length).toBeGreaterThan(0);
  });

  it('enforces read-only safety without order placement tools', () => {
    const properties = Object.getOwnPropertyNames(Object.getPrototypeOf(orchestrator));
    const dangerousMethods = properties.filter((p) => /order|trade|execute|cancel|modify/i.test(p));
    expect(dangerousMethods).toEqual([]);
  });

  it('runs deterministic screening and two-stage funnel deep dive', async () => {
    const screenRes = await orchestrator.screen('IT_TECH', 'QUALITY_COMPOUNDERS');
    expect(screenRes.universe).toBe('IT_TECH');
    expect(screenRes.candidates.length).toBeGreaterThanOrEqual(3);

    const funnelRes = await orchestrator.screenAndAnalyze('IT_TECH', 'QUALITY_COMPOUNDERS', 2);
    expect(funnelRes.screener).toBeDefined();
    expect(funnelRes.analyzedRuns.length).toBeLessThanOrEqual(2);
    if (funnelRes.analyzedRuns.length > 0) {
      expect(funnelRes.analyzedRuns[0].verdict).toBeDefined();
    }
  });
});
