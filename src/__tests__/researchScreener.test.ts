import { StockScreener } from '../services/research/screener';
import { listUniverses, resolveUniverse } from '../services/research/universe';
import { classifyHorizons, computePerformance } from '../services/research/performance';
import { type Candle } from '../services/research/types';

// Fake scrip master. The real one is fetched (and cached) by the SDK; these
// tests assert the screener's own logic, not DhanHQ's data.
function fakeClient(rows?: any[]) {
  const equities = rows || [
    { securityId: '2885', underlyingSymbol: 'RELIANCE', displayName: 'Reliance Industries', series: 'EQ' },
    { securityId: '11536', underlyingSymbol: 'TCS', displayName: 'Tata Consultancy Services', series: 'EQ' },
    { securityId: '1594', underlyingSymbol: 'INFY', displayName: 'Infosys', series: 'EQ' },
    { securityId: '7229', underlyingSymbol: 'HCLTECH', displayName: 'HCL Technologies', series: 'EQ' },
    { securityId: '13538', underlyingSymbol: 'TECHM', displayName: 'Tech Mahindra', series: 'EQ' },
    { securityId: '3787', underlyingSymbol: 'WIPRO', displayName: 'Wipro', series: 'EQ' },
    { securityId: '9999', underlyingSymbol: 'SMALLCO', displayName: 'Small Co', series: 'BE' }, // non-EQ series
    { securityId: '8888', underlyingSymbol: '011NSETEST', displayName: 'Test Contract', series: 'EQ' },
  ];
  const fno = [
    { underlyingSymbol: 'RELIANCE', instrument: 'OPTSTK' },
    { underlyingSymbol: 'TCS', instrument: 'OPTSTK' },
    { underlyingSymbol: 'NIFTY', instrument: 'INDEX' },
    { underlyingSymbol: '011NSETEST', instrument: 'OPTSTK' },
  ];
  return {
    instruments: {
      bySegment: jest.fn(async (seg: string) => (seg === 'NSE_FNO' ? fno : equities)),
    },
  };
}

/** Deterministic series: `days` sessions compounding at `dailyPct`. */
function series(days: number, start: number, dailyPct: number, volume = 1_000_000): Candle[] {
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < days; i++) {
    price *= 1 + dailyPct / 100;
    out.push({ close: price, high: price * 1.01, low: price * 0.99, volume });
  }
  return out;
}

describe('Research universe — resolved from the scrip master', () => {
  it('resolves security ids from the live master instead of a hardcoded table', async () => {
    const refs = await resolveUniverse(fakeClient(), 'IT_TECH');
    const tcs = refs.find((r) => r.symbol === 'TCS');
    expect(tcs?.securityId).toBe('11536');
    expect(tcs?.exchangeSegment).toBe('NSE_EQ');
  });

  it('drops symbols with no cash listing rather than guessing an id', async () => {
    // Empty master -> nothing resolves, and nothing is invented.
    const refs = await resolveUniverse(fakeClient([]), 'IT_TECH');
    expect(refs).toHaveLength(0);
  });

  it('excludes Dhan test contracts and non-EQ series from the F&O universe', async () => {
    const refs = await resolveUniverse(fakeClient(), 'FNO_UNDERLYINGS');
    expect(refs.map((r) => r.symbol)).toEqual(['RELIANCE', 'TCS']); // no NSETEST, no INDEX
  });

  it('resolves against BSE when asked', async () => {
    const client = fakeClient();
    await resolveUniverse(client, 'IT_TECH', 'BSE');
    expect(client.instruments.bySegment).toHaveBeenCalledWith('BSE_EQ');
  });

  it('accepts BSE group codes, which are not NSE-style EQ series', async () => {
    // Found live: filtering BSE on series === 'EQ' emptied the whole BSE
    // universe, because BSE labels groups 'A'/'B' instead.
    const bseRows = [
      { securityId: '532540', underlyingSymbol: 'TCS', displayName: 'TCS', series: 'A', instrument: 'EQUITY' },
      { securityId: '500209', underlyingSymbol: 'INFY', displayName: 'Infosys', series: 'B', instrument: 'EQUITY' },
      { securityId: '999999', underlyingSymbol: 'HCLTECH', displayName: 'Penalty Co', series: 'Z', instrument: 'EQUITY' },
    ];
    const refs = await resolveUniverse(fakeClient(bseRows), 'IT_TECH', 'BSE');
    expect(refs.map((r) => r.symbol).sort()).toEqual(['INFY', 'TCS']); // Z group excluded
    expect(refs.find((r) => r.symbol === 'TCS')?.exchangeSegment).toBe('BSE_EQ');
  });

  it('lists universes including the live F&O count', async () => {
    const universes = await listUniverses(fakeClient());
    expect(universes.find((u) => u.id === 'FNO_UNDERLYINGS')?.count).toBe(2);
  });
});

describe('Performance metrics and horizon classification', () => {
  it('returns null rather than scoring a symbol with too little history', () => {
    expect(computePerformance(series(30, 100, 0.1))).toBeNull();
  });

  it('classifies a sustained uptrend as long-term (and swing, at the highs)', () => {
    const p = computePerformance(series(300, 100, 0.3), series(300, 100, 0.05))!;
    expect(p).not.toBeNull();
    const horizons = classifyHorizons(p);
    expect(horizons).toContain('LONG_TERM');
    expect(horizons).toContain('SWING');
    expect(p.relativeStrength250d!).toBeGreaterThan(0); // beating the benchmark
  });

  it('gives a downtrend no horizon at all', () => {
    const p = computePerformance(series(300, 100, -0.2), series(300, 100, 0.05))!;
    expect(classifyHorizons(p)).toHaveLength(0);
  });

  it('does not claim a long-term trend when 200DMA direction is unknown', () => {
    // 210 sessions: enough for a 200DMA, not enough for the month-ago
    // comparison that proves it is rising.
    const p = computePerformance(series(210, 100, 0.3), series(210, 100, 0.05))!;
    expect(p.sma200Rising).toBeNull();
    expect(classifyHorizons(p)).not.toContain('LONG_TERM');
  });
});

describe('StockScreener — real price-based screening', () => {
  const screener = new StockScreener();

  function marketFor(map: Record<string, Candle[]>, benchmark: Candle[]) {
    return {
      client: fakeClient(),
      getBenchmarkCandles: jest.fn(async () => benchmark),
      getHistoricalCandles: jest.fn(async (ref: any) => map[ref.symbol] || []),
    } as any;
  }

  it('refuses to screen when the benchmark history is unavailable', async () => {
    // Null relative strength would otherwise fail every stock for a reason
    // that has nothing to do with the stocks.
    const market = marketFor({ TCS: series(300, 100, 0.3) }, []);
    await expect(screener.screen('IT_TECH', 'MOMENTUM_BREAKOUT', market, 'NSE'))
      .rejects.toThrow(/Benchmark .* unavailable/);
  });

  it('passes a strong uptrend and fails a downtrend on the momentum preset', async () => {
    const bench = series(300, 100, 0.05);
    const market = marketFor({
      TCS: series(300, 100, 0.3),
      INFY: series(300, 100, -0.2),
      HCLTECH: series(300, 100, 0.3),
      TECHM: series(300, 100, -0.2),
      WIPRO: series(300, 100, 0.3),
    }, bench);

    const res = await screener.screen('IT_TECH', 'MOMENTUM_BREAKOUT', market, 'NSE');

    expect(res.exchange).toBe('NSE');
    expect(res.totalScreened).toBe(5);
    expect(res.topPicks).toContain('TCS');
    expect(res.candidates.find((c) => c.symbol === 'INFY')!.passed).toBe(false);
    expect(res.candidates.find((c) => c.symbol === 'TCS')!.horizons).toContain('SWING');
  });

  it('reports symbols with insufficient history as skipped, not as failures', async () => {
    const market = marketFor({ TCS: series(300, 100, 0.3), INFY: series(10, 100, 0.3) }, series(300, 100, 0.05));
    const res = await screener.screen('IT_TECH', 'MOMENTUM_BREAKOUT', market, 'NSE');

    expect(res.candidates.map((c) => c.symbol)).toEqual(['TCS']);
    expect(res.skipped).toBe(4); // INFY (short history) + 3 with no candles at all
  });

  it('retries a dropped fetch and reports it as a fetch failure, not as missing history', async () => {
    // Found live: the provider swallowed fetch errors and returned [], so a
    // rate-limited request was reported as "insufficient history" — TECHM was
    // dropped from every screen while returning 271 clean candles on its own.
    const bench = series(300, 100, 0.05);
    let techmCalls = 0;
    const market = {
      client: fakeClient(),
      getBenchmarkCandles: jest.fn(async () => bench),
      getHistoricalCandles: jest.fn(async (ref: any) => {
        if (ref.symbol === 'TECHM') { techmCalls++; throw new Error('429 rate limited'); }
        if (ref.symbol === 'WIPRO') return series(10, 100, 0.3); // genuinely too short
        return series(300, 100, 0.3);
      }),
    } as any;

    const res = await screener.screen('IT_TECH', 'MOMENTUM_BREAKOUT', market, 'NSE');

    expect(techmCalls).toBe(2); // retried once before giving up
    expect(res.skippedFetchFailed).toEqual(['TECHM']);
    expect(res.skippedNoHistory).toEqual(['WIPRO']);
    expect(res.candidates.map((c) => c.symbol).sort()).toEqual(['HCLTECH', 'INFY', 'TCS']);
  });

  it('recovers when the retry succeeds', async () => {
    let calls = 0;
    const market = {
      client: fakeClient(),
      getBenchmarkCandles: jest.fn(async () => series(300, 100, 0.05)),
      getHistoricalCandles: jest.fn(async (ref: any) => {
        if (ref.symbol === 'TCS' && calls++ === 0) throw new Error('transient blip');
        return series(300, 100, 0.3);
      }),
    } as any;

    const res = await screener.screen('IT_TECH', 'MOMENTUM_BREAKOUT', market, 'NSE');
    expect(res.skippedFetchFailed).toEqual([]);
    expect(res.candidates.map((c) => c.symbol)).toContain('TCS');
  });

  it('rejects an illiquid stock however strong its trend', async () => {
    // Same winning price series, but a volume too thin to trade.
    const market = marketFor({ TCS: series(300, 100, 0.3, 1) }, series(300, 100, 0.05));
    const res = await screener.screen('IT_TECH', 'MOMENTUM_BREAKOUT', market, 'NSE');

    const tcs = res.candidates.find((c) => c.symbol === 'TCS')!;
    expect(tcs.passed).toBe(false);
    expect(tcs.failedRules.some((r) => /Liquidity/.test(r))).toBe(true);
  });

  it('sorts passing candidates first, then by score descending', async () => {
    const bench = series(300, 100, 0.05);
    const market = marketFor({
      TCS: series(300, 100, 0.4),
      INFY: series(300, 100, -0.2),
      HCLTECH: series(300, 100, 0.15),
      TECHM: series(300, 100, 0.3),
      WIPRO: series(300, 100, -0.1),
    }, bench);

    const res = await screener.screen('IT_TECH', 'MOMENTUM_BREAKOUT', market, 'NSE');
    for (let i = 0; i < res.candidates.length - 1; i++) {
      const a = res.candidates[i], b = res.candidates[i + 1];
      if (a.passed === b.passed) expect(a.deterministicScore).toBeGreaterThanOrEqual(b.deterministicScore);
      else expect(a.passed).toBe(true);
    }
  });
});
