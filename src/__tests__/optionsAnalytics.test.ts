import {
  calculateGreeks, analyzeOptionChain, selectStrikeByDelta, aggregatePortfolioGreeks,
} from '../services/optionsAnalytics';
import {
  buildIronCondor, buildCreditSpread, buildStraddle, buildStrangle, evaluateStrategyBacktest,
  buildOrbBuyingStrategy, buildVwapPullbackStrategy, calculateFnoFrictions, calculatePositionSize,
} from '../services/strategyConstructor';

const sampleChain = [
  { strike: 24000, ce: { oi: 10000, volume: 5000, ltp: 550, iv: 15, securityId: '101' }, pe: { oi: 50000, volume: 20000, ltp: 10, iv: 15, securityId: '201' } },
  { strike: 24200, ce: { oi: 20000, volume: 15000, ltp: 380, iv: 14, securityId: '102' }, pe: { oi: 40000, volume: 18000, ltp: 25, iv: 14, securityId: '202' } },
  { strike: 24500, ce: { oi: 60000, volume: 45000, ltp: 150, iv: 13, securityId: '103' }, pe: { oi: 65000, volume: 50000, ltp: 140, iv: 13, securityId: '203' } },
  { strike: 24800, ce: { oi: 80000, volume: 30000, ltp: 30, iv: 14, securityId: '104' }, pe: { oi: 15000, volume: 8000, ltp: 360, iv: 14, securityId: '204' } },
  { strike: 25000, ce: { oi: 95000, volume: 35000, ltp: 8, iv: 15, securityId: '105' }, pe: { oi: 5000, volume: 2000, ltp: 520, iv: 15, securityId: '205' } },
];

const expiry = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);

describe('Options & Volatility Analytics Core', () => {

  it('calculates Black-Scholes Greeks with correct sign conventions', () => {
    const callGreeks = calculateGreeks(24500, 24500, expiry, 'CALL', 0.14);
    const putGreeks = calculateGreeks(24500, 24500, expiry, 'PUT', 0.14);

    expect(callGreeks.delta).toBeGreaterThan(0.45);
    expect(callGreeks.delta).toBeLessThan(0.55);
    expect(putGreeks.delta).toBeLessThan(-0.45);
    expect(putGreeks.delta).toBeGreaterThan(-0.55);

    expect(callGreeks.gamma).toBeGreaterThan(0);
    expect(callGreeks.theta).toBeLessThan(0); // Time decay is negative
    expect(callGreeks.vega).toBeGreaterThan(0);
  });

  it('analyzes option chain metrics (PCR, Max Pain, ATM, and Volatility Regime)', () => {
    const analytics = analyzeOptionChain('NIFTY', sampleChain, 24500, expiry, 14);

    expect(analytics.symbol).toBe('NIFTY');
    expect(analytics.spot).toBe(24500);
    expect(analytics.atmStrike).toBe(24500);
    expect(analytics.pcrOi).toBeGreaterThan(0.5);
    expect(analytics.highestCallOiStrike).toBe(25000);
    expect(analytics.highestPutOiStrike).toBe(24500);
    expect(analytics.maxPainStrike).toBeDefined();
    expect(analytics.regime).toBeDefined();
  });

  it('selects strikes dynamically based on target delta', () => {
    const atmCall = selectStrikeByDelta(sampleChain, 0.50, 'CALL', 24500, expiry);
    const otmPut = selectStrikeByDelta(sampleChain, 0.10, 'PUT', 24500, expiry);

    expect(atmCall).toBeDefined();
    expect(atmCall.strike).toBe(24500);

    expect(otmPut).toBeDefined();
    expect(otmPut.strike).toBeLessThan(24500);
  });

  it('aggregates total portfolio Net Greeks correctly across multiple positions', () => {
    const positions = [
      { tradingSymbol: 'NIFTY24500CE', netQty: 50, ltp: 150 }, // Long 2 lots NIFTY ATM Call (+Delta)
      { tradingSymbol: 'NIFTY24500PE', netQty: -50, ltp: 140 }, // Short 2 lots NIFTY ATM Put (+Delta)
    ];

    const spotMap = { NIFTY: 24500 };
    const agg = aggregatePortfolioGreeks(positions, spotMap, expiry);

    expect(agg.totalPositions).toBe(2);
    expect(agg.netDelta).toBeGreaterThan(0); // Long call + short put both have positive delta
  });
});

describe('Multi-Leg Strategy Constructors', () => {
  const sampleChain = [
    { strike: 24000, ce: { oi: 10000, ltp: 550, iv: 15, securityId: '101' }, pe: { oi: 50000, ltp: 10, iv: 15, securityId: '201' } },
    { strike: 24200, ce: { oi: 20000, ltp: 380, iv: 14, securityId: '102' }, pe: { oi: 40000, ltp: 25, iv: 14, securityId: '202' } },
    { strike: 24500, ce: { oi: 60000, ltp: 150, iv: 13, securityId: '103' }, pe: { oi: 65000, ltp: 140, iv: 13, securityId: '203' } },
    { strike: 24800, ce: { oi: 80000, ltp: 30, iv: 14, securityId: '104' }, pe: { oi: 15000, ltp: 360, iv: 14, securityId: '204' } },
    { strike: 25000, ce: { oi: 95000, ltp: 8, iv: 15, securityId: '105' }, pe: { oi: 5000, ltp: 520, iv: 15, securityId: '205' } },
  ];
  const expiry = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);

  it('constructs an Iron Condor with margin-first BUY legs ordering', () => {
    const ic = buildIronCondor('NIFTY', 24500, sampleChain, expiry, 1);
    expect(ic).not.toBeNull();
    expect(ic?.type).toBe('IRON_CONDOR');
    expect(ic?.legs.length).toBe(4);

    // Verify first 2 legs are BUY (long wings) to capture margin benefits first
    expect(ic?.legs[0].side).toBe('BUY');
    expect(ic?.legs[1].side).toBe('BUY');
    expect(ic?.legs[2].side).toBe('SELL');
    expect(ic?.legs[3].side).toBe('SELL');
  });

  it('constructs a Bull Put Credit Spread with long hedge ordered first', () => {
    const spread = buildCreditSpread('NIFTY', 'BULLISH', 24500, sampleChain, expiry, 1);
    expect(spread).not.toBeNull();
    expect(spread?.type).toBe('BULL_PUT_SPREAD');
    expect(spread?.legs.length).toBe(2);
    expect(spread?.legs[0].side).toBe('BUY');
    expect(spread?.legs[1].side).toBe('SELL');
  });

  it('constructs ATM Straddle and OTM Strangle correctly', () => {
    const straddle = buildStraddle('NIFTY', 24500, sampleChain, expiry, 1, 'SELL');
    expect(straddle).not.toBeNull();
    expect(straddle?.legs.length).toBe(2);

    const strangle = buildStrangle('NIFTY', 24500, sampleChain, expiry, 1, 'SELL');
    expect(strangle).not.toBeNull();
    expect(strangle?.legs.length).toBe(2);
  });
});

describe('Strategy Backtest Evaluation Engine', () => {
  const sampleDays = [
    {
      date: '2026-08-27',
      spot: { open: 24500, high: 24600, low: 24450, close: 24520 },
      strikes: [{ label: 'ATM', strike: 24500, call: { open: 150, close: 110 }, put: { open: 140, close: 100 } }],
      timeline: [
        { time: '09:15', spot: 24500, ce: 150, pe: 140, straddle: 290 },
        { time: '11:00', spot: 24550, ce: 140, pe: 110, straddle: 250 },
        { time: '13:30', spot: 24520, ce: 120, pe: 105, straddle: 225 },
        { time: '15:20', spot: 24510, ce: 110, pe: 100, straddle: 210 },
      ],
    },
    {
      date: '2026-08-28',
      spot: { open: 24500, high: 24800, low: 24480, close: 24780 },
      strikes: [{ label: 'ATM', strike: 24500, call: { open: 150, close: 320 }, put: { open: 140, close: 20 } }],
      timeline: [
        { time: '09:15', spot: 24500, ce: 150, pe: 140, straddle: 290 },
        { time: '10:30', spot: 24700, ce: 280, pe: 35, straddle: 315 },
        { time: '13:30', spot: 24750, ce: 300, pe: 25, straddle: 325 },
        { time: '15:20', spot: 24780, ce: 320, pe: 20, straddle: 340 },
      ],
    },
  ];

  it('evaluates Short Straddle backtest accurately across historical days', () => {
    const report = evaluateStrategyBacktest('NIFTY', 'STRADDLE', sampleDays, {
      targetPct: 20, slPct: 15, side: 'SELL', lots: 1,
    });

    expect(report.symbol).toBe('NIFTY');
    expect(report.totalDays).toBe(2);
    expect(report.days.length).toBe(2);
    // Day 1 premium decays 290 -> 225 at 13:30 (Target +20% reached since 290-225 = 65 pts gain >= 58 pts)
    expect(report.days[0].pnl).toBeGreaterThan(0);
    // Day 2 big expansion 290 -> 340 (Short loss)
    expect(report.days[1].pnl).toBeLessThan(0);
    expect(report.winRate).toBe(50);
  });

  it('evaluates Options Buying strategies, friction calculations, and 1% risk position sizing', () => {
    const orbBuy = buildOrbBuyingStrategy('NIFTY', 24500, sampleChain, expiry, 1, 'BULLISH');
    expect(orbBuy).not.toBeNull();
    expect(orbBuy?.legs[0].side).toBe('BUY');
    expect(orbBuy?.lotSize).toBe(65);

    const vwapBuy = buildVwapPullbackStrategy('BANKNIFTY', 58000, sampleChain, expiry, 1, 'BEARISH');
    expect(vwapBuy).not.toBeNull();
    expect(vwapBuy?.lotSize).toBe(30);

    // 1% risk position sizing: ₹10,00,000 capital, 50 pt stop on NIFTY (lot: 65)
    // Risk budget = ₹10,000. Risk/lot = 50 * 65 = 3250. Max lots = floor(10000 / 3250) = 3 lots.
    const size = calculatePositionSize(1000000, 50, 'NIFTY', 1);
    expect(size.lots).toBe(3);
    expect(size.qty).toBe(195);

    // F&O frictions on ₹200 entry -> ₹300 exit (65 qty):
    const fno = calculateFnoFrictions(200, 300, 65);
    expect(fno.stt).toBe(19.5); // 300 * 65 * 0.0010 = 19.50
    expect(fno.brokerage).toBe(40); // ₹20 in + ₹20 out
    expect(fno.totalFriction).toBeGreaterThan(50);
  });
});
