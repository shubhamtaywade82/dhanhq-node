import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { createDhanClient } from '../src/auth';
import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import {
  evaluateStrategyBacktest,
  calculateFnoFrictions,
  BacktestReport,
} from '../src/services/strategyConstructor';
import { analyzeOptionsBehavior } from '../src/routes/market';

// ── 1. Strategy Universe Definition ─────────────────────────────────────

export interface StrategyDefinition {
  type: string;
  category: string;
  targetPct: number;
  slPct: number;
  side: 'BUY' | 'SELL';
  timeExit: string;
}

export const STRATEGY_UNIVERSE: StrategyDefinition[] = [
  { type: 'SHORT_STRANGLE', category: 'Theta Decay (2-Leg OTM)', targetPct: 35, slPct: 45, side: 'SELL', timeExit: '15:20' },
  { type: 'SHORT_STRADDLE', category: 'Theta Decay (2-Leg ATM)', targetPct: 30, slPct: 40, side: 'SELL', timeExit: '15:20' },
  { type: 'IRON_CONDOR', category: 'Neutral Range (4-Leg Credit)', targetPct: 45, slPct: 50, side: 'SELL', timeExit: '15:20' },
  { type: 'IRON_BUTTERFLY', category: 'Neutral Pin (4-Leg Credit)', targetPct: 40, slPct: 50, side: 'SELL', timeExit: '15:20' },
  { type: 'BULL_PUT_SPREAD', category: 'Bullish Vertical Credit', targetPct: 50, slPct: 50, side: 'SELL', timeExit: '15:20' },
  { type: 'BEAR_CALL_SPREAD', category: 'Bearish Vertical Credit', targetPct: 50, slPct: 50, side: 'SELL', timeExit: '15:20' },
  { type: 'BULL_CALL_SPREAD', category: 'Bullish Vertical Debit', targetPct: 60, slPct: 40, side: 'BUY', timeExit: '15:20' },
  { type: 'BEAR_PUT_SPREAD', category: 'Bearish Vertical Debit', targetPct: 60, slPct: 40, side: 'BUY', timeExit: '15:20' },
  { type: 'ORB_15M', category: '15M Breakout Buying', targetPct: 75, slPct: 35, side: 'BUY', timeExit: '15:20' },
  { type: 'ORB_30M', category: '30M Breakout Buying', targetPct: 85, slPct: 40, side: 'BUY', timeExit: '15:20' },
  { type: 'VWAP_RSI_PULLBACK', category: 'Trend Pullback Buying', targetPct: 70, slPct: 35, side: 'BUY', timeExit: '15:20' },
  { type: 'LONG_STRADDLE', category: 'IV Expansion Volatility', targetPct: 60, slPct: 30, side: 'BUY', timeExit: '15:20' },
];

export interface StrategyScorecard {
  symbol: string;
  type: string;
  category: string;
  winRate: number;
  totalDays: number;
  wins: number;
  losses: number;
  grossPnlInr: number;
  frictionInr: number;
  netPnlInr: number;
  profitFactor: number;
  maxDrawdownRoi: number;
  passedValidation: boolean;
  edgeScore: number;
}

// ── 2. Local Persistent Data Cache ──────────────────────────────────────

const CACHE_DIR = path.resolve(__dirname, '../.cache/backtest');

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getCacheFilePath(symbol: string, daysCount: number): string {
  const today = new Date().toISOString().split('T')[0];
  return path.join(CACHE_DIR, `${symbol}_${daysCount}d_${today}.json`);
}

function loadCachedDays(symbol: string, daysCount: number): any[] | null {
  ensureCacheDir();
  const file = getCacheFilePath(symbol, daysCount);
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data) && data.length > 0) return data;
    } catch { /* ignore corrupted cache */ }
  }
  return null;
}

function saveCachedDays(symbol: string, daysCount: number, days: any[]): void {
  ensureCacheDir();
  const file = getCacheFilePath(symbol, daysCount);
  try {
    fs.writeFileSync(file, JSON.stringify(days, null, 2), 'utf8');
  } catch { /* non-fatal cache write */ }
}

// ── 4. Unified Multi-Strategy Pipeline Runner ───────────────────────────

export async function runFullOptionsBacktest(
  client: DhanClient,
  symbol: 'NIFTY' | 'SENSEX',
  daysCount = 15,
): Promise<StrategyScorecard[]> {
  const secId = symbol === 'SENSEX' ? '51' : '13';

  console.log(`\n[Backtest] ── Preparing Dataset for ${symbol} (Sessions: ${daysCount}) ──`);

  // 1. Check local persistent disk cache first
  let daysData: any[] = loadCachedDays(symbol, daysCount) || [];

  // 2. Fetch from DhanHQ API if not cached — no synthetic fallback. A
  // backtest run on invented price paths is worse than no backtest: it
  // reports PASSED/REJECTED with false confidence. If DhanHQ has no real
  // rolling-option history for this window, surface that and stop.
  if (daysData.length === 0) {
    const analysis = await analyzeOptionsBehavior(client, {
      symbol,
      securityId: secId,
      daysCount,
      interval: '15',
      expiryFlag: 'WEEK',
      expiryCode: 1,
    });
    daysData = analysis.days || [];
    if (daysData.length === 0) {
      throw new Error(`${symbol}: analyzeOptionsBehavior returned zero usable sessions`);
    }
    saveCachedDays(symbol, daysCount, daysData);
    console.log(`  • Fetched & Cached ${daysData.length} live historical sessions from DhanHQ.`);
  } else {
    console.log(`  • Loaded ${daysData.length} sessions directly from local disk cache (.cache/backtest/).`);
  }

  // 3. Evaluate Strategy Universe
  const scorecards: StrategyScorecard[] = [];

  for (const strat of STRATEGY_UNIVERSE) {
    const report: BacktestReport = evaluateStrategyBacktest(symbol, strat.type, daysData, {
      targetPct: strat.targetPct,
      slPct: strat.slPct,
      side: strat.side,
      timeExit: strat.timeExit,
      lots: 1,
    });

    const edgeScore = Number((report.winRate * (report.profitFactor || 1) * (report.netPnlInr > 0 ? 1 : -1)).toFixed(1));

    scorecards.push({
      symbol,
      type: strat.type,
      category: strat.category,
      winRate: report.winRate,
      totalDays: report.totalDays,
      wins: report.wins,
      losses: report.totalDays - report.wins,
      grossPnlInr: report.totalPnlInr,
      frictionInr: report.totalFrictionInr,
      netPnlInr: report.netPnlInr,
      profitFactor: report.profitFactor,
      maxDrawdownRoi: report.maxDrawdownRoi,
      passedValidation: report.passedValidation && report.netPnlInr > 0,
      edgeScore,
    });
  }

  // Sort descending by Net P&L and Edge Score
  scorecards.sort((a, b) => b.netPnlInr - a.netPnlInr);
  return scorecards;
}

// ── 5. Main CLI Runner ──────────────────────────────────────────────────

function formatInr(val: number): string {
  const sign = val >= 0 ? '+' : '-';
  const abs = Math.abs(val);
  return `${sign}₹${abs.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function main() {
  console.log(`========================================================================================`);
  console.log(` Multi-Strategy Options Backtesting & Edge Ranking Engine (real DhanHQ history only)`);
  console.log(` Strategies: 12 Setups | Statutory Frictions: STT 0.10%, Stamp Duty, ₹20 Brokerage, 18% GST, 0.25% Slippage`);
  console.log(`========================================================================================`);

  const client = await createDhanClient();
  let anyFailed = false;

  for (const sym of ['NIFTY', 'SENSEX'] as const) {
    let scorecards: StrategyScorecard[];
    try {
      scorecards = await runFullOptionsBacktest(client, sym, 15);
    } catch (err: any) {
      anyFailed = true;
      console.log(`\n❌ ${sym}: ${err.message} — skipping (no synthetic fallback; results would be fabricated).`);
      continue;
    }

    console.log(`\n┌─ ${sym} Strategy Performance & Edge Ranking Matrix ──────────────────────────────────────────`);
    console.log(`│ ${'Strategy'.padEnd(20)} | ${'Category'.padEnd(27)} | ${'Win%'.padStart(6)} | ${'Gross P&L'.padStart(13)} | ${'Frictions'.padStart(10)} | ${'Net P&L'.padStart(13)} | ${'PF'.padStart(5)} | ${'Edge'}`);
    console.log(`├──────────────────────┼─────────────────────────────┼────────┼───────────────┼────────────┼───────────────┼───────┼──────────`);

    for (const s of scorecards) {
      const edgeBadge = s.passedValidation ? '✅ PASSED' : '❌ REJECT';
      console.log(
        `│ ${s.type.padEnd(20)} | ${s.category.padEnd(27)} | ${(s.winRate + '%').padStart(6)} | ${formatInr(s.grossPnlInr).padStart(13)} | ${('₹' + s.frictionInr.toFixed(0)).padStart(10)} | ${formatInr(s.netPnlInr).padStart(13)} | ${s.profitFactor.toFixed(2).padStart(5)} | ${edgeBadge}`,
      );
    }
    console.log(`└─────────────────────────────────────────────────────────────────────────────────────────────────────────\n`);
  }

  if (anyFailed) {
    console.log(`⚠️  Completed with gaps — at least one symbol had no real DhanHQ history for this window.`);
    process.exit(1);
  }
  console.log(`✅ Backtest completed on real DhanHQ rolling-option history.`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`❌ Pipeline Error: ${err.message}`);
    process.exit(1);
  });
}
