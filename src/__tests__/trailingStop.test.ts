import { PositionMonitor } from '@nemesis-oss/dhanhq-sdk';
import { toTrailConfig } from '../services/marketData';

/**
 * Regression coverage for a severe pre-existing bug: PositionMonitor.track()
 * requires `trail: { atr, multiplier }`, but every call site in this
 * codebase passed a raw distance number or `{ distance }`. Neither shape
 * has `.atr`, so the SDK's TrailManager always computed
 * `candidate = highestPrice - undefined * multiplier` = NaN, and
 * `NaN > currentStop` is always false — the trail NEVER advanced. Since
 * every leg also sets an explicit stopLoss alongside it in practice, this
 * degraded every "trailing" stop in the system to a static one; a
 * trailing-only position (no separate stopLoss) would have had ITS
 * STOP THRESHOLD COMPUTE AS NaN, meaning ltp <= NaN — always false — so it
 * would never have exited at all.
 */
function tick(monitor: PositionMonitor, securityId: string, ltp: number) {
  monitor.onTick({
    type: 'ticker', responseCode: 0, messageLength: 0, exchangeSegmentCode: 0,
    exchangeSegment: 'NSE_FNO', securityId, ltp, ltt: Math.floor(Date.now() / 1000),
    raw: Buffer.alloc(0),
  } as any);
}

describe('toTrailConfig', () => {
  it('maps a plain distance number to { atr, multiplier: 1 }', () => {
    expect(toTrailConfig(15)).toEqual({ atr: 15, multiplier: 1 });
  });

  it('maps a { distance } object (strategyConstructor.ts leg shape) the same way', () => {
    expect(toTrailConfig({ distance: 15 })).toEqual({ atr: 15, multiplier: 1 });
  });

  it('returns undefined for zero, negative, null, or undefined — no trail configured', () => {
    expect(toTrailConfig(0)).toBeUndefined();
    expect(toTrailConfig(-5)).toBeUndefined();
    expect(toTrailConfig(null)).toBeUndefined();
    expect(toTrailConfig(undefined)).toBeUndefined();
  });
});

describe('PositionMonitor + toTrailConfig — the trail actually trails', () => {
  it('ratchets the stop up as price makes new highs and exits once price falls through it (long, no explicit stopLoss)', () => {
    const monitor = new PositionMonitor();
    const exits: any[] = [];
    monitor.on('exit', (s) => exits.push(s));

    // No stopLoss at all — this is exactly the case that was silently
    // unprotected before the fix (initialStop would have computed as NaN).
    monitor.track({
      securityId: '44000', exchangeSegment: 'NSE_FNO',
      quantity: 50, entryPrice: 100,
      trail: toTrailConfig(10), // trail 10 points off the high-water mark
    });

    tick(monitor, '44000', 100); // baseline
    expect(exits.length).toBe(0);

    tick(monitor, '44000', 120); // new high — trailing stop should now sit at 110
    expect(exits.length).toBe(0);

    tick(monitor, '44000', 115); // above 110 — must NOT exit
    expect(exits.length).toBe(0);

    tick(monitor, '44000', 108); // below 110 — must exit now
    expect(exits.length).toBe(1);
    expect(exits[0].reason).toBe('trailing_stop');
    expect(exits[0].price).toBe(108);
  });

  it('never trails and never protects when trail is passed in the OLD unmapped shape (documents the bug this fix closes)', () => {
    const monitor = new PositionMonitor();
    const exits: any[] = [];
    monitor.on('exit', (s) => exits.push(s));

    // The exact shape every call site used to pass directly, pre-fix.
    monitor.track({
      securityId: '44001', exchangeSegment: 'NSE_FNO',
      quantity: 50, entryPrice: 100,
      trail: 10 as any,
    });

    tick(monitor, '44001', 100);
    tick(monitor, '44001', 120);
    tick(monitor, '44001', 50); // a catastrophic drop — should obviously exit a real trailing stop
    expect(exits.length).toBe(0); // and does not, with the old shape — this is the bug
  });
});
