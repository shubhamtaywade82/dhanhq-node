import {
  applyExitFill,
  createLongOptionState,
  decideLongOption,
  netPnl,
  type FeeEstimator,
  type LongOptionPolicyConfig,
} from '../services/longOptionExitPolicy';

const fees: FeeEstimator = (side, quantity, price) => {
  const value = quantity * price;
  return 20 + value * 0.0005 + (side === 'SELL' ? value * 0.001 : 0);
};

const config: LongOptionPolicyConfig = {
  stopLossPct: 0.25,
  ratchet: [
    { peakR: 0.25, giveback: 0.6, floorR: 0 },
    { peakR: 0.5, giveback: 0.45, floorR: 0.1 },
    { peakR: 1, giveback: 0.35, floorR: 0.4 },
  ],
  firstPartialAtR: 0.5,
  firstPartialFraction: 0.4,
  confirmationTicks: 2,
  confirmationMs: 1500,
};

describe('long option exit policy', () => {
  it('marks P&L net of entry and exit fees', () => {
    const state = createLongOptionState(100, 75, fees, config);
    expect(netPnl(state, 120, fees)).toBeLessThan(1500);
    expect(netPnl(state, 120, fees)).toBeGreaterThan(0);
  });

  it('locks a partial after the configured confirmed peak', () => {
    const state = createLongOptionState(100, 75, fees, config);
    const decision = decideLongOption(state, { bid: 150, timestamp: 1, confirmed: true, isEndOfDay: false }, fees, config);
    expect(decision.action).toBe('PARTIAL');
    expect(decision.fraction).toBe(0.4);
  });

  it('never lowers the locked floor after a higher peak', () => {
    const state = createLongOptionState(100, 75, fees, config);
    decideLongOption(state, { bid: 150, timestamp: 1, confirmed: true, isEndOfDay: false }, fees, config);
    const floor = state.floorNet;
    decideLongOption(state, { bid: 170, timestamp: 2, confirmed: true, isEndOfDay: false }, fees, config);
    expect(state.floorNet).toBeGreaterThanOrEqual(floor);
  });

  it('requires confirmation for a normal giveback but exits immediately on a hard breach', () => {
    const state = createLongOptionState(100, 75, fees, config);
    const first = decideLongOption(state, { bid: 150, timestamp: 1, confirmed: true, isEndOfDay: false }, fees, config);
    // Simulate the caller confirming the fill for that first PARTIAL — the
    // policy itself never marks partialTaken; a caller must do it once the
    // sell actually executes (see applyExitFill call sites).
    if (first.action === 'PARTIAL') state.partialTaken = true;
    const soft = decideLongOption(state, { bid: 140, timestamp: 2, confirmed: true, isEndOfDay: false }, fees, config);
    expect(soft.action).toBe('HOLD');
    const recovered = decideLongOption(state, { bid: 150, timestamp: 3, confirmed: true, isEndOfDay: false }, fees, config);
    expect(recovered.action).not.toBe('EXIT');
    // isolated re-breach long after recovery must not instantly "confirm" off stale breach state
    const late = decideLongOption(state, { bid: 140, timestamp: 999999, confirmed: true, isEndOfDay: false }, fees, config);
    expect(late.action).toBe('HOLD');
    const hardConfig = { ...config, ratchet: [{ peakR: 0.25, giveback: 0.1, floorR: -1 }] };
    const hardState = createLongOptionState(100, 75, fees, hardConfig);
    decideLongOption(hardState, { bid: 150, timestamp: 1, confirmed: true, isEndOfDay: false }, fees, hardConfig);
    const hard = decideLongOption(hardState, { bid: 100, timestamp: 3, confirmed: true, isEndOfDay: false }, fees, hardConfig);
    expect(hard.action).toBe('EMERGENCY_EXIT');
  });

  it('books a partial fill, leaving the remainder marked at the live bid', () => {
    const state = createLongOptionState(100, 75, fees, config);
    const before = netPnl(state, 150, fees);
    applyExitFill(state, 30, 150, fees);
    expect(state.remainingQuantity).toBe(45);
    // same total qty sold at the same bid costs one extra flat brokerage leg
    // (two fills instead of one) — net P&L drops by exactly that, nothing else.
    expect(before - netPnl(state, 150, fees)).toBeCloseTo(20, 0);
  });
});
