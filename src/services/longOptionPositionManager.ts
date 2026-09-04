import { eventBus } from './eventBus';
import type { MarketDataService } from './marketData';
import { executePaperOrder, closePaperPosition, defaultMarginResolver, calculateOrderCharges, listPaperPositions, closeParentStrategyIfFlat } from '../db';
import {
  applyExitFill, createLongOptionState, decideLongOption, DEFAULT_LONG_OPTION_POLICY_CONFIG,
  type FeeEstimator, type LongOptionState,
} from './longOptionExitPolicy';

// Same per-fill fee model the paper engine actually charges (src/db.ts) —
// the policy's net P&L must match what the ledger will show, not an estimate.
const fees: FeeEstimator = (side, quantity, price) => calculateOrderCharges(side, price, quantity);
const CONFIG = DEFAULT_LONG_OPTION_POLICY_CONFIG;

/**
 * Peak-profit protection for long option paper positions — the same
 * decision core validated in scripts/backtest-long-option-policy.ts, run
 * against every live open long option on every tick/cycle. Runs alongside
 * (not instead of) each position's own PositionMonitor stop-loss/target:
 * whichever fires first closes the position; the other finds it already
 * flat and no-ops (see closePaperPosition/executePaperOrder).
 *
 * ponytail: policy state (peak/floor/partials-taken) lives in-memory only,
 * keyed by tradingSymbol. A process restart loses ratchet history for any
 * position opened before it and resumes from the position's real cost
 * basis (buyAvg) with a fresh floor — P&L stays correct, only the "don't
 * give back what we already earned" memory resets. Upgrade path: persist
 * {peakNet, floorNet, partialTaken} onto paper_positions if restart-safety
 * mid-session becomes a real problem.
 */
export class LongOptionPositionManager {
  private states = new Map<string, LongOptionState>();
  private enabled = process.env.LONG_OPTION_POLICY_ENABLED !== 'false';
  private evaluating = false;

  constructor(private market: MarketDataService) {}

  setEnabled(on: boolean): void {
    this.enabled = on;
    eventBus.log('SYSTEM', `Long-option peak-profit policy ${on ? 'ENABLED' : 'DISABLED'}`, 'long_option_policy');
  }

  isEnabled(): boolean { return this.enabled; }

  /** Read-only observability hook (also used by tests) — current policy
   * state for a tracked symbol, if any. */
  getState(tradingSymbol: string): Readonly<LongOptionState> | undefined {
    return this.states.get(tradingSymbol);
  }

  /** Per-position view for control-plane/frontend consumption — what the
   * whole system exists to show: how much profit is locked in vs. still at
   * risk of being given back, right now, for every open long option. */
  snapshot(): Array<{
    tradingSymbol: string; remainingQuantity: number; peakNet: number; floorNet: number;
    captureRatioSoFar: number | null; partialTaken: boolean;
  }> {
    return [...this.states.entries()].map(([tradingSymbol, s]) => ({
      tradingSymbol,
      remainingQuantity: s.remainingQuantity,
      peakNet: Number(s.peakNet.toFixed(2)),
      floorNet: Number(s.floorNet.toFixed(2)),
      captureRatioSoFar: s.peakNet > 0 ? Number(((s.realizedNet - s.buyFees) / s.peakNet).toFixed(3)) : null,
      partialTaken: s.partialTaken,
    }));
  }

  /** Both the tick-driven and the 2s-cycle caller can invoke this before the
   * previous run's sell order round-trips the DB — an overlapping run would
   * both read the same netQty, both decide PARTIAL, and both sell against
   * it. This guard makes a run that lands mid-flight a no-op instead. */
  async evaluate(isEndOfDay: boolean): Promise<void> {
    if (!this.enabled || this.evaluating) return;
    this.evaluating = true;
    try {
      const positions = await listPaperPositions();
      const seen = new Set<string>();

      for (const pos of positions) {
        if (pos.netQty <= 0 || !String(pos.exchangeSegment || '').endsWith('_FNO')) continue;
        seen.add(pos.tradingSymbol);
        await this.evaluateOne(pos, isEndOfDay);
      }

      // Position closed by some other path (manual close, EOD square-off,
      // strategy loss-limit) — drop its policy state so a later re-entry
      // under the same symbol starts clean instead of inheriting a stale peak.
      for (const symbol of [...this.states.keys()]) {
        if (!seen.has(symbol)) this.states.delete(symbol);
      }
    } finally {
      this.evaluating = false;
    }
  }

  private async evaluateOne(pos: any, isEndOfDay: boolean): Promise<void> {
    let state = this.states.get(pos.tradingSymbol);
    if (!state) {
      state = createLongOptionState(pos.buyAvg, pos.netQty, fees, CONFIG);
      this.states.set(pos.tradingSymbol, state);
    } else if (state.remainingQuantity !== pos.netQty) {
      // Quantity drifted from something other than our own applyExitFill —
      // most commonly an add-to fill increasing it. Resync qty/cost basis
      // IN PLACE; a fresh createLongOptionState here would wipe peakNet/
      // floorNet/partialTaken and hand back the never-red guarantee on a
      // position that already earned it.
      state.remainingQuantity = pos.netQty;
      state.entryPrice = pos.buyAvg;
    }

    // This is LTP, not best bid — self-consistent in paper mode (paper fills
    // are priced off the same LTP), but the whole peak/floor design assumes
    // an EXECUTABLE mark. Must switch to real option-chain bid before this
    // manager is ever pointed at live positions.
    const bid = this.market.getFillablePrice(pos.securityId, { allowClosed: true, maxAgeMs: 10_000 }) ?? this.market.getLtp(pos.securityId);
    if (!(bid && bid > 0)) return; // no fresh price — never decide on a stale/missing mark

    const decision = decideLongOption(state, { bid, timestamp: Date.now(), confirmed: true, isEndOfDay }, fees, CONFIG);
    if (decision.action === 'HOLD') return;

    if (decision.action === 'PARTIAL' && decision.fraction) {
      const qty = Math.floor(decision.fraction * state.remainingQuantity);
      if (qty <= 0 || qty >= state.remainingQuantity) return; // nothing sensible to split off
      await this.sell(pos, qty, bid, state, `partial (${decision.reason})`, decision.reason === 'lock_profit');
      return;
    }

    await this.sell(pos, state.remainingQuantity, bid, state, decision.reason, false);
  }

  private async sell(pos: any, qty: number, bid: number, state: LongOptionState, reason: string, isFirstPartial: boolean): Promise<void> {
    try {
      const result: any = qty >= pos.netQty
        ? await closePaperPosition(pos.tradingSymbol, bid)
        : await executePaperOrder({
            symbol: pos.tradingSymbol, securityId: String(pos.securityId), exchangeSegment: pos.exchangeSegment,
            transactionType: 'SELL', orderType: 'MARKET', productType: pos.productType, quantity: qty, price: bid,
            correlationId: `long_policy_${pos.tradingSymbol}_${Date.now()}`,
          }, defaultMarginResolver);
      if (result.status !== 'TRADED') return;

      applyExitFill(state, qty, result.fillPrice, fees);
      // Only mark the breakeven-lock partial as taken once its fill actually
      // confirms — a reject here must let decideLongOption retry it next tick.
      if (isFirstPartial) state.partialTaken = true;
      eventBus.log('TRADE', `Long-option policy: ${reason} — sold ${qty} ${pos.tradingSymbol} @ ₹${result.fillPrice.toFixed(2)} (peak ₹${state.peakNet.toFixed(0)}, ${state.remainingQuantity} left)`, 'long_option_policy');

      if (state.remainingQuantity <= 0) {
        this.market.monitor.untrack(pos.exchangeSegment, String(pos.securityId));
        this.states.delete(pos.tradingSymbol);
        // Found live: a single-leg strategy whose only exit is this policy
        // (the adaptive-supertrend scanner deliberately sets no risk_limits
        // and relies entirely on this ratchet) stayed stuck at status
        // RUNNING forever once closed here — nothing told the parent
        // strategy record. Same reconciliation every other exit path uses.
        await closeParentStrategyIfFlat(pos.tradingSymbol, await listPaperPositions());
      }
    } catch (e: any) {
      eventBus.log('ERROR', `Long-option policy sell failed for ${pos.tradingSymbol}: ${e.message}`, 'long_option_policy');
    }
  }
}
