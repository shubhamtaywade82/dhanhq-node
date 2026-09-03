export type ExitAction = 'HOLD' | 'PARTIAL' | 'EXIT' | 'EMERGENCY_EXIT';

export interface LongOptionPolicyConfig {
  stopLossPct: number;
  ratchet: Array<{ peakR: number; giveback: number; floorR: number }>;
  firstPartialAtR: number;
  firstPartialFraction: number;
  confirmationTicks: number;
  confirmationMs: number;
}

export interface LongOptionSnapshot {
  bid: number;
  timestamp: number;
  confirmed: boolean;
  isEndOfDay: boolean;
}

export interface LongOptionState {
  entryPrice: number;
  quantity: number;
  remainingQuantity: number;
  buyFees: number;
  realizedNet: number;
  risk: number;
  peakNet: number;
  floorNet: number;
  breachSince: number | null;
  breachTicks: number;
  partialTaken: boolean;
}

export interface PolicyDecision {
  action: ExitAction;
  reason: string;
  fraction?: number;
}

export type FeeEstimator = (side: 'BUY' | 'SELL', quantity: number, price: number) => number;

/** Default ratchet tuned in scripts/backtest-long-option-policy.ts — shared
 * by the backtest and the live paper manager so "same decision core" stays
 * true after a tune, not just at the moment this was written. */
export const DEFAULT_LONG_OPTION_POLICY_CONFIG: LongOptionPolicyConfig = {
  stopLossPct: 0.28,
  ratchet: [
    { peakR: 0.25, giveback: 0.6, floorR: 0 },
    { peakR: 0.5, giveback: 0.45, floorR: 0.1 },
    { peakR: 1.0, giveback: 0.35, floorR: 0.4 },
    { peakR: 2.0, giveback: 0.25, floorR: 1.2 },
    { peakR: 3.0, giveback: 0.2, floorR: 2.0 },
  ],
  firstPartialAtR: 0.5,
  firstPartialFraction: 0.4,
  confirmationTicks: 2,
  confirmationMs: 1500,
};

export function createLongOptionState(
  entryPrice: number,
  quantity: number,
  feeEstimator: FeeEstimator,
  config: LongOptionPolicyConfig,
): LongOptionState {
  const buyFees = feeEstimator('BUY', quantity, entryPrice);
  const stopPrice = entryPrice * (1 - config.stopLossPct);
  const risk = (entryPrice - stopPrice) * quantity + buyFees + feeEstimator('SELL', quantity, stopPrice);
  return {
    entryPrice, quantity, remainingQuantity: quantity, buyFees, realizedNet: 0,
    risk, peakNet: 0, floorNet: -risk, breachSince: null, breachTicks: 0, partialTaken: false,
  };
}

/** Applies an executed exit fill (full or partial) to state — must be called
 * by the caller once the broker/paper engine confirms the sell, so a decision
 * ('PARTIAL' or 'EXIT') is never assumed filled before it actually is. */
export function applyExitFill(state: LongOptionState, quantity: number, price: number, feeEstimator: FeeEstimator): void {
  const qty = Math.min(quantity, state.remainingQuantity);
  if (qty <= 0) return;
  const sellFees = feeEstimator('SELL', qty, price);
  state.realizedNet += (price - state.entryPrice) * qty - sellFees;
  state.remainingQuantity -= qty;
}

export function netPnl(state: LongOptionState, bid: number, feeEstimator: FeeEstimator): number {
  if (!(bid > 0) || state.remainingQuantity <= 0) return state.realizedNet - state.buyFees;
  const sellFees = feeEstimator('SELL', state.remainingQuantity, bid);
  return state.realizedNet + (bid - state.entryPrice) * state.remainingQuantity - sellFees - state.buyFees;
}

export function updatePeak(
  state: LongOptionState,
  snapshot: LongOptionSnapshot,
  feeEstimator: FeeEstimator,
  config: LongOptionPolicyConfig,
): number {
  const net = netPnl(state, snapshot.bid, feeEstimator);
  if (!snapshot.confirmed) return net;
  if (net > state.peakNet) {
    state.peakNet = net;
    const row = ratchetRow(state.peakNet / state.risk, config);
    if (row.floorR >= 0) state.floorNet = Math.max(state.floorNet, row.floorR * state.risk);
  }
  return net;
}

export function decideLongOption(
  state: LongOptionState,
  snapshot: LongOptionSnapshot,
  feeEstimator: FeeEstimator,
  config: LongOptionPolicyConfig,
): PolicyDecision {
  const net = updatePeak(state, snapshot, feeEstimator, config);
  if (snapshot.isEndOfDay) return { action: 'EMERGENCY_EXIT', reason: 'end_of_day' };
  if (net <= -state.risk) return { action: 'EMERGENCY_EXIT', reason: 'hard_stop' };
  if (state.floorNet > -state.risk && net <= state.floorNet) return { action: 'EXIT', reason: 'profit_floor' };
  const row = ratchetRow(state.peakNet / state.risk, config);
  const allowance = Math.max(row.giveback * state.peakNet, state.risk * 0.02);
  const giveback = state.peakNet - net;
  const hard = giveback > allowance * 1.5;
  if (hard) return { action: 'EMERGENCY_EXIT', reason: 'giveback_hard' };
  if (giveback > allowance) {
    if (confirmedBreach(state, snapshot.timestamp, config)) {
      return { action: 'EXIT', reason: 'giveback_confirmed' };
    }
  } else {
    state.breachSince = null;
    state.breachTicks = 0;
  }
  if (!state.partialTaken && state.peakNet >= config.firstPartialAtR * state.risk) {
    // Caller must set state.partialTaken = true once the fill actually
    // confirms (see applyExitFill callers) — setting it here would
    // permanently skip the breakeven lock on a transient order reject.
    return { action: 'PARTIAL', reason: 'lock_profit', fraction: config.firstPartialFraction };
  }
  return { action: 'HOLD', reason: 'within_policy' };
}

function ratchetRow(peakR: number, config: LongOptionPolicyConfig) {
  const rows = [...config.ratchet].sort((a, b) => b.peakR - a.peakR);
  return rows.find((row) => peakR >= row.peakR) ?? { peakR: 0, giveback: 1, floorR: -1 };
}

function confirmedBreach(state: LongOptionState, timestamp: number, config: LongOptionPolicyConfig): boolean {
  if (!state.breachSince) state.breachSince = timestamp;
  state.breachTicks += 1;
  return state.breachTicks >= config.confirmationTicks || timestamp - state.breachSince >= config.confirmationMs;
}

