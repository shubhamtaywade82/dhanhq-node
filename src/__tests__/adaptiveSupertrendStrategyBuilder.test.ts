import { buildAdaptiveSupertrendStrategy } from '../services/strategyConstructor';

const sampleChain = [
  { strike: 24000, ce: { oi: 10000, volume: 5000, ltp: 550, iv: 15, securityId: '101' }, pe: { oi: 50000, volume: 20000, ltp: 10, iv: 15, securityId: '201' } },
  { strike: 24200, ce: { oi: 20000, volume: 15000, ltp: 380, iv: 14, securityId: '102' }, pe: { oi: 40000, volume: 18000, ltp: 25, iv: 14, securityId: '202' } },
  { strike: 24500, ce: { oi: 60000, volume: 45000, ltp: 150, iv: 13, securityId: '103' }, pe: { oi: 65000, volume: 50000, ltp: 140, iv: 13, securityId: '203' } },
  { strike: 24800, ce: { oi: 80000, volume: 30000, ltp: 30, iv: 14, securityId: '104' }, pe: { oi: 15000, volume: 8000, ltp: 360, iv: 14, securityId: '204' } },
  { strike: 25000, ce: { oi: 95000, volume: 35000, ltp: 8, iv: 15, securityId: '105' }, pe: { oi: 5000, volume: 2000, ltp: 520, iv: 15, securityId: '205' } },
];

const expiry = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
const spot = 24500; // matches the 24500 strike row for a clean ATM pick

describe('buildAdaptiveSupertrendStrategy', () => {
  it('builds a naked ATM CE buy with no trailing stop', () => {
    const strat = buildAdaptiveSupertrendStrategy('NIFTY', spot, sampleChain, expiry, 1, 'CE');
    expect(strat).not.toBeNull();
    expect(strat!.type).toBe('ADAPTIVE_SUPERTREND');
    expect(strat!.legs).toHaveLength(1);
    const leg = strat!.legs[0]!;
    expect(leg.side).toBe('BUY');
    expect(leg.optionType).toBe('CE');
    expect(leg.strike).toBe(24500);
    expect(leg.trailingStop).toBeUndefined();
  });

  it('builds a naked ATM PE buy with no trailing stop', () => {
    const strat = buildAdaptiveSupertrendStrategy('NIFTY', spot, sampleChain, expiry, 1, 'PE');
    expect(strat).not.toBeNull();
    const leg = strat!.legs[0]!;
    expect(leg.optionType).toBe('PE');
    expect(leg.strike).toBe(24500);
    expect(leg.trailingStop).toBeUndefined();
  });

  it('still sets a hard-backstop stopLoss even without a trailing stop', () => {
    const strat = buildAdaptiveSupertrendStrategy('NIFTY', spot, sampleChain, expiry, 1, 'CE');
    expect(strat!.legs[0]!.stopLoss).toBeGreaterThan(0);
  });

  it('returns null on an empty option chain', () => {
    expect(buildAdaptiveSupertrendStrategy('NIFTY', spot, [], expiry, 1, 'CE')).toBeNull();
  });

  it('routes SENSEX legs to BSE_FNO', () => {
    const strat = buildAdaptiveSupertrendStrategy('SENSEX', spot, sampleChain, expiry, 1, 'CE');
    expect(strat!.legs[0]!.exchangeSegment).toBe('BSE_FNO');
  });
});
