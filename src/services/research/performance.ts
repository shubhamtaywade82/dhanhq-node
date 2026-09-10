import { type Candle, type PerformanceMetrics, type TradeHorizon } from './types';

/**
 * Price/volume performance metrics for the screener.
 *
 * Everything here is derived from real daily OHLCV. Nothing is synthesized:
 * the previous screener scored fabricated fundamentals (identical numbers for
 * every symbol) against technicals computed from an empty candle array, so
 * every stock tied and the "top picks" were just universe ordering.
 */

const TRADING_DAYS = { swing: 20, short: 60, long: 250 } as const;

function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
  return sum / period;
}

/** Percentage return over the last `period` sessions. */
function pctReturn(closes: number[], period: number): number | null {
  if (closes.length <= period) return null;
  const past = closes[closes.length - 1 - period];
  if (!(past > 0)) return null;
  return ((closes[closes.length - 1] - past) / past) * 100;
}

/** Annualized-ish daily volatility, as a percentage. */
function volatilityPct(closes: number[], period = 20): number | null {
  if (closes.length <= period) return null;
  const rets: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev > 0) rets.push((closes[i] - prev) / prev);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * 100;
}

export function computePerformance(candles: Candle[], benchmark?: Candle[]): PerformanceMetrics | null {
  // 200DMA plus a lookback needs a real history; a short series would silently
  // produce nulls that read as "no trend" rather than "not enough data".
  if (candles.length < 60) return null;
  const closes = candles.map((c) => c.close);
  const close = closes[closes.length - 1];
  if (!(close > 0)) return null;

  const window = candles.slice(-TRADING_DAYS.long);
  const high52w = Math.max(...window.map((c) => c.high));
  const low52w = Math.min(...window.map((c) => c.low));

  const recent = candles.slice(-20);
  const avgTradedValue = recent.reduce((sum, c) => sum + c.close * c.volume, 0) / recent.length;

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  // Rising 200DMA = today's average above where it sat a month ago.
  const sma200Prev = closes.length >= 220 ? sma(closes.slice(0, -20), 200) : null;

  const benchCloses = benchmark?.map((c) => c.close) || [];
  const relativeStrength = (period: number): number | null => {
    const own = pctReturn(closes, period);
    const bench = benchCloses.length ? pctReturn(benchCloses, period) : null;
    if (own == null || bench == null) return null;
    return own - bench;
  };

  return {
    close,
    return20d: pctReturn(closes, TRADING_DAYS.swing),
    return60d: pctReturn(closes, TRADING_DAYS.short),
    return250d: pctReturn(closes, TRADING_DAYS.long),
    sma20, sma50, sma200,
    sma200Rising: sma200 != null && sma200Prev != null ? sma200 > sma200Prev : null,
    high52w,
    low52w,
    pctFrom52wHigh: high52w > 0 ? ((close - high52w) / high52w) * 100 : null,
    volatilityPct: volatilityPct(closes),
    avgTradedValue,
    relativeStrength60d: relativeStrength(TRADING_DAYS.short),
    relativeStrength250d: relativeStrength(TRADING_DAYS.long),
    candleCount: candles.length,
  };
}

/**
 * Which holding horizons this stock currently qualifies for. A stock can
 * qualify for several — a long-term uptrend that is also breaking out is both
 * LONG_TERM and SWING — so this returns every match rather than one bucket.
 */
export function classifyHorizons(p: PerformanceMetrics): TradeHorizon[] {
  const horizons: TradeHorizon[] = [];

  // Swing: short-term trend intact and pushing toward the highs.
  if (p.sma20 != null && p.close > p.sma20 && (p.return20d ?? 0) > 0
    && p.pctFrom52wHigh != null && p.pctFrom52wHigh > -15) {
    horizons.push('SWING');
  }

  // Short-term/positional: above the 50DMA and outperforming over a quarter.
  if (p.sma50 != null && p.close > p.sma50 && (p.return60d ?? 0) > 0
    && (p.relativeStrength60d ?? 0) > 0) {
    horizons.push('SHORT_TERM');
  }

  // Long-term: primary uptrend — above a rising 200DMA, beating the index
  // over a year. sma200Rising being null (short history) fails this on
  // purpose rather than assuming the trend is up.
  if (p.sma200 != null && p.close > p.sma200 && p.sma200Rising === true
    && (p.relativeStrength250d ?? 0) > 0) {
    horizons.push('LONG_TERM');
  }

  return horizons;
}

/**
 * 0-100 composite. Weighted toward relative strength (the thing that actually
 * separates performers) with trend alignment as confirmation.
 */
export function performanceScore(p: PerformanceMetrics, horizons: TradeHorizon[]): number {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  const rs60 = clamp((p.relativeStrength60d ?? 0) + 10, 0, 40); // -10%..+30% -> 0..40
  const rs250 = clamp(((p.relativeStrength250d ?? 0) + 20) / 2, 0, 25); // -20%..+30% -> 0..25
  const trend = [
    p.sma20 != null && p.close > p.sma20,
    p.sma50 != null && p.close > p.sma50,
    p.sma200 != null && p.close > p.sma200,
    p.sma200Rising === true,
  ].filter(Boolean).length * 5; // 0..20
  const proximity = clamp(15 + (p.pctFrom52wHigh ?? -100) / 2, 0, 15); // at highs -> 15

  return Math.round(clamp(rs60 + rs250 + trend + proximity, 0, 100));
}
