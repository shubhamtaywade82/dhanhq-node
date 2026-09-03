import { modelledHalfSpread, applyFillSlippage } from '../services/fillModel';

describe('modelledHalfSpread', () => {
  it('widens with premium in discrete brackets', () => {
    expect(modelledHalfSpread(10)).toBeCloseTo(0.05, 2); // cheap far-OTM
    expect(modelledHalfSpread(50)).toBeCloseTo(0.25, 2);
    expect(modelledHalfSpread(150)).toBeCloseTo(0.5, 2); // typical near-ATM weekly
    expect(modelledHalfSpread(500)).toBeCloseTo(1.0, 2); // rich ATM/ITM
  });

  it('treats a zero, negative, or missing price as the minimum tick', () => {
    expect(modelledHalfSpread(0)).toBeCloseTo(0.05, 2);
    expect(modelledHalfSpread(-5)).toBeCloseTo(0.05, 2);
  });
});

describe('applyFillSlippage', () => {
  it('a BUY entry pays the ask side (reference + half-spread)', () => {
    expect(applyFillSlippage(100, 'BUY', 'ENTRY')).toBeCloseTo(100.5, 2);
  });

  it('a SELL entry receives the bid side (reference - half-spread)', () => {
    expect(applyFillSlippage(100, 'SELL', 'ENTRY')).toBeCloseTo(99.5, 2);
  });

  it('a STOP pays one extra half-spread beyond the ordinary exit cost, in the adverse direction', () => {
    // Closing a long via a triggered stop SELLs — adverse means an even
    // lower fill than a plain exit at the same reference price.
    const plainExit = applyFillSlippage(100, 'SELL', 'EXIT');
    const stopExit = applyFillSlippage(100, 'SELL', 'STOP');
    expect(stopExit).toBeLessThan(plainExit);
    expect(plainExit - stopExit).toBeCloseTo(modelledHalfSpread(100), 2);
  });

  it('rounds to the nearest tick and never returns below one tick', () => {
    const filled = applyFillSlippage(0.03, 'BUY', 'ENTRY');
    expect(filled).toBeGreaterThanOrEqual(0.05);
    expect(Number((filled / 0.05).toFixed(6)) % 1).toBe(0); // exact multiple of one tick
  });
});
