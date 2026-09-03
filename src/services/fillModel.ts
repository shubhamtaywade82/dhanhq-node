/**
 * Paper-fill pricing model shared by every fill path — entries
 * (PaperExecutionEngine.placeOrder) and exits (db.ts closePaperPosition,
 * which every auto-exit/EOD/kill-switch/manual-close path funnels through).
 *
 * Previously entries paid a flat one-tick (₹0.05) slippage regardless of
 * premium, and exits paid NONE at all (closePaperPosition filled exactly at
 * the reference LTP). Neither matches reality: a real NIFTY weekly ATM
 * option quotes a ₹0.50-1.50 spread, wider still for BANKNIFTY/SENSEX or
 * anything off-ATM, so a flat tick understated round-trip cost by roughly
 * 10-20x — enough to invalidate a paper P&L or backtest result built on it.
 *
 * DhanHQ's quote payload here doesn't carry usable market-depth for this
 * engine's needs, so the spread is modelled off premium rather than read
 * from a live book — real spreads widen with premium (deeper ITM/richer
 * ATM contracts see wider absolute spreads than cheap far-OTM ones).
 */

export type FillKind = 'ENTRY' | 'EXIT' | 'STOP';

const TICK = 0.05;

/** Half-spread estimate, in rupees, for an index option at the given
 * premium. Bucketed rather than continuous — deliberately coarse, since
 * this is a model standing in for a book we don't have, not a fit to one. */
export function modelledHalfSpread(referencePrice: number): number {
  if (!(referencePrice > 0)) return TICK;
  if (referencePrice < 20) return 1 * TICK; // ~0.05 — cheap far-OTM weekly
  if (referencePrice < 100) return 5 * TICK; // ~0.25
  if (referencePrice < 300) return 10 * TICK; // ~0.50 — typical near-ATM weekly
  return 20 * TICK; // ~1.00 — rich ATM/ITM premium
}

/**
 * Applies the spread model to a reference price for a side and fill kind.
 * A BUY pays the ask side (reference + half-spread); a SELL receives the
 * bid side (reference - half-spread). A STOP additionally pays for crossing
 * on the adverse move that triggered it — real stop slippage comes
 * predominantly from the move itself, not merely the resting spread — so it
 * is modelled as one extra half-spread beyond the ordinary marketable cost.
 * Rounds to the nearest tick and floors at one tick, matching how the
 * exchange itself prices option premium.
 */
export function applyFillSlippage(referencePrice: number, side: 'BUY' | 'SELL', kind: FillKind = 'ENTRY'): number {
  const half = modelledHalfSpread(referencePrice);
  const extra = kind === 'STOP' ? half : 0;
  const signed = side === 'BUY' ? half + extra : -(half + extra);
  const raw = referencePrice + signed;
  return Math.max(TICK, Math.round(raw / TICK) * TICK);
}
