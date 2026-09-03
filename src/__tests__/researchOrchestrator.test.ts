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

  beforeEach(() => {
    mockClient = {
      marketFeed: {
        quote: jest.fn().mockResolvedValue({ data: { NSE_EQ: { '2885': { ltp: 1350, volume: 500000, close: 1340 } } } }),
      },
      charts: {
        historical: jest.fn().mockResolvedValue({
          close: [1300, 1310, 1320, 1330, 1340, 1350],
          high: [1310, 1320, 1330, 1340, 1350, 1360],
          low: [1290, 1300, 1310, 1320, 1330, 1340],
          volume: [10000, 12000, 11000, 15000, 14000, 16000],
        }),
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
