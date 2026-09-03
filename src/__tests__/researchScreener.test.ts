import { StockScreener } from '../services/research/screener';
import { getUniverseSymbols, listUniverses } from '../services/research/universe';
import { DefaultFundamentalProvider, MarketDataProvider } from '../services/research/dataProviders';

describe('StockScreener — Deterministic Multi-Stock Filtering', () => {
  let screener: StockScreener;
  let fundamentalProvider: DefaultFundamentalProvider;
  let mockMarketProvider: MarketDataProvider;

  beforeEach(() => {
    screener = new StockScreener();
    fundamentalProvider = new DefaultFundamentalProvider();
    mockMarketProvider = {
      getQuote: jest.fn().mockResolvedValue({ ltp: 1300, volume: 100000, prevClose: 1290 }),
    } as any;
  });

  it('resolves universe symbols and lists universes correctly', () => {
    const universes = listUniverses();
    expect(universes.length).toBeGreaterThanOrEqual(3);
    const n50 = universes.find((u) => u.id === 'NIFTY_50');
    expect(n50).toBeDefined();
    expect(n50!.count).toBeGreaterThanOrEqual(10);

    const fnoSymbols = getUniverseSymbols('FNO_HEAVYWEIGHTS');
    expect(fnoSymbols.some((s) => s.symbol === 'RELIANCE')).toBe(true);
    expect(fnoSymbols.some((s) => s.symbol === 'TCS')).toBe(true);
  });

  it('screens universe with QUALITY_COMPOUNDERS preset', async () => {
    const res = await screener.screen('FNO_HEAVYWEIGHTS', 'QUALITY_COMPOUNDERS', mockMarketProvider, fundamentalProvider);

    expect(res.universe).toBe('FNO_HEAVYWEIGHTS');
    expect(res.preset).toBe('QUALITY_COMPOUNDERS');
    expect(res.totalScreened).toBeGreaterThan(0);
    expect(res.candidates.length).toBe(res.totalScreened);

    // Verify candidate properties
    const first = res.candidates[0];
    expect(first.symbol).toBeDefined();
    expect(first.cmp).toBeGreaterThan(0);
    expect(first.deterministicScore).toBeGreaterThanOrEqual(0);
    expect(first.deterministicScore).toBeLessThanOrEqual(100);
    expect(first.metrics.cfoVsPat).toBeGreaterThan(0);

    // Candidates must be sorted with passed first, then score descending
    for (let i = 0; i < res.candidates.length - 1; i++) {
      if (res.candidates[i].passed === res.candidates[i + 1].passed) {
        expect(res.candidates[i].deterministicScore).toBeGreaterThanOrEqual(res.candidates[i + 1].deterministicScore);
      } else {
        expect(res.candidates[i].passed).toBe(true);
        expect(res.candidates[i + 1].passed).toBe(false);
      }
    }
  });

  it('screens universe with VALUE_MARGIN_OF_SAFETY preset', async () => {
    const res = await screener.screen('IT_TECH', 'VALUE_MARGIN_OF_SAFETY', mockMarketProvider, fundamentalProvider);

    expect(res.universe).toBe('IT_TECH');
    expect(res.preset).toBe('VALUE_MARGIN_OF_SAFETY');
    expect(res.candidates.length).toBeGreaterThanOrEqual(3);
  });
});
