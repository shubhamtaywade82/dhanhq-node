import dotenv from 'dotenv';
dotenv.config();

import { createDhanClient } from '../src/auth';
import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import { analyzeOptionsBehavior } from '../src/routes/market';
import { getLotSize } from '../src/services/strategyConstructor';
import { calculateOrderCharges } from '../src/db';
import {
  applyExitFill,
  createLongOptionState,
  decideLongOption,
  DEFAULT_LONG_OPTION_POLICY_CONFIG,
  type FeeEstimator,
  type LongOptionState,
} from '../src/services/longOptionExitPolicy';

// Same per-fill fee model the live paper engine charges (src/db.ts), and the
// same ratchet src/services/longOptionPositionManager.ts runs — this harness
// only means anything if it's scoring the config actually deployed.
const fees: FeeEstimator = (side, quantity, price) => calculateOrderCharges(side, price, quantity);
const CONFIG = DEFAULT_LONG_OPTION_POLICY_CONFIG;

interface TradeResult {
  date: string;
  leg: 'CE' | 'PE';
  entryPrice: number;
  finalNet: number;
  peakNet: number;
  // null when the peak never cleared the capture-gate (design brief:
  // M >= max(3 x round-trip fee, 0.25R)) — below that, finalNet/peakNet is a
  // near-zero-denominator ratio (e.g. -14) that would dominate and corrupt
  // the average. These trades are counted separately instead (see report()).
  captureRatio: number | null;
  exitReason: string;
}

/** ponytail: `d.strikes[].timeline` comes from the existing DhanHQ rolling-
 * option pipeline (src/routes/market.ts), which decimates each session to
 * ~35 bars (~11 min apart) to keep chain-analysis responses small. That's
 * fine for peak/floor/giveback scoring but too coarse to validate the
 * sub-2-tick / 1.5s confirmation window — every bar here already exceeds
 * that window, so confirmation is effectively instant in this harness.
 * Upgrade path if tick-level tuning is ever needed: fetch client.expiredOptionsData
 * directly (bypasses the decimation) instead of analyzeOptionsBehavior. */
function simulateLeg(day: any, leg: 'CE' | 'PE', lotSize: number): TradeResult | null {
  const atm = (day.strikes || []).find((s: any) => s.label === 'ATM');
  const timeline: any[] = atm?.timeline;
  if (!timeline || timeline.length < 2) return null;

  const field = leg === 'CE' ? 'ce' : 'pe';
  const entryPrice = Number(timeline[0][field]);
  if (!(entryPrice > 0)) return null;

  const state: LongOptionState = createLongOptionState(entryPrice, lotSize, fees, CONFIG);
  let exitReason = 'held_to_close';

  for (let i = 1; i < timeline.length; i++) {
    const bar = timeline[i];
    const bid = Number(bar[field]);
    if (!(bid > 0)) continue;
    const isEndOfDay = i === timeline.length - 1;
    const decision = decideLongOption(state, { bid, timestamp: i, confirmed: true, isEndOfDay }, fees, CONFIG);

    if (decision.action === 'PARTIAL' && decision.fraction) {
      applyExitFill(state, Math.round(decision.fraction * state.remainingQuantity), bid, fees);
      if (decision.reason === 'lock_profit') state.partialTaken = true;
      continue;
    }
    if (decision.action === 'EXIT' || decision.action === 'EMERGENCY_EXIT') {
      applyExitFill(state, state.remainingQuantity, bid, fees);
      exitReason = decision.reason;
      break;
    }
  }

  // Anything still open at the last bar exits there (session close).
  if (state.remainingQuantity > 0) {
    const lastBid = Number(timeline[timeline.length - 1][field]);
    if (lastBid > 0) applyExitFill(state, state.remainingQuantity, lastBid, fees);
  }

  const finalNet = state.realizedNet - state.buyFees;
  const roundTripFee = fees('BUY', lotSize, entryPrice) + fees('SELL', lotSize, entryPrice);
  const captureGate = Math.max(3 * roundTripFee, 0.25 * state.risk);
  return {
    date: day.date,
    leg,
    entryPrice,
    finalNet: Number(finalNet.toFixed(2)),
    peakNet: Number(state.peakNet.toFixed(2)),
    captureRatio: state.peakNet >= captureGate ? Number((finalNet / state.peakNet).toFixed(3)) : null,
    exitReason,
  };
}

async function runSymbol(client: DhanClient, symbol: 'NIFTY' | 'SENSEX', daysCount: number): Promise<TradeResult[]> {
  const secId = symbol === 'SENSEX' ? '51' : '13';
  const analysis = await analyzeOptionsBehavior(client, {
    symbol, securityId: secId, daysCount, interval: '1', expiryFlag: 'WEEK', expiryCode: 1,
  });
  const days = analysis.days || [];
  const lotSize = getLotSize(symbol);
  const results: TradeResult[] = [];
  for (const day of days) {
    for (const leg of ['CE', 'PE'] as const) {
      const r = simulateLeg(day, leg, lotSize);
      if (r) results.push(r);
    }
  }
  return results;
}

function report(symbol: string, results: TradeResult[]): void {
  if (results.length === 0) {
    console.log(`\n${symbol}: no usable sessions.`);
    return;
  }
  const netPnl = results.reduce((s, r) => s + r.finalNet, 0);
  const wins = results.filter((r) => r.finalNet > 0).length;
  const gated = results.filter((r) => r.captureRatio !== null);
  const belowGate = results.length - gated.length;
  const avgCapture = gated.length > 0 ? gated.reduce((s, r) => s + (r.captureRatio || 0), 0) / gated.length : null;
  const totalGiveback = gated.reduce((s, r) => s + Math.max(0, r.peakNet - r.finalNet), 0);
  const reasonCounts = new Map<string, number>();
  for (const r of results) reasonCounts.set(r.exitReason, (reasonCounts.get(r.exitReason) || 0) + 1);

  // DEBUG_TRADES=1: per-trade dump, for tracing a specific exit reason/ratio
  // back to which day/leg produced it during tuning.
  if (process.env.DEBUG_TRADES) console.log(JSON.stringify(results, null, 2));
  console.log(`\n┌─ ${symbol} — long-option exit policy backtest (${results.length} trades, ATM CE+PE, session-open entry) ──`);
  console.log(`│ Net P&L: ₹${netPnl.toFixed(0)}  |  Win rate: ${((wins / results.length) * 100).toFixed(1)}%  |  Avg capture ratio: ${avgCapture !== null ? (avgCapture * 100).toFixed(1) + '%' : 'n/a'} (${gated.length} trades cleared the capture gate, ${belowGate} never went meaningfully green)`);
  console.log(`│ Total giveback (peak - final, gated trades only): ₹${totalGiveback.toFixed(0)}`);
  console.log(`│ Exit reasons: ${[...reasonCounts.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`└──────────────────────────────────────────────────────────────────────────────────────\n`);
}

async function main() {
  console.log('Long-option exit policy backtest — real DhanHQ rolling-option history only (no synthetic prices).');
  const client = await createDhanClient();
  const daysCount = Number(process.argv[2]) || 15;

  for (const sym of ['NIFTY', 'SENSEX'] as const) {
    try {
      const results = await runSymbol(client, sym, daysCount);
      report(sym, results);
    } catch (e: any) {
      console.log(`\n${sym}: ${e.message} — skipping.`);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Backtest error: ${err.message}`);
    process.exit(1);
  });
}
