import { type MarketDataProvider } from './dataProviders';
import { resolveUniverse, type ExchangePreference } from './universe';
import { classifyHorizons, computePerformance, performanceScore } from './performance';
import {
  type Candle,
  type InstrumentRef,
  type PerformanceMetrics,
  type ScreenerCandidate,
  type ScreenerPresetName,
  type ScreenerResult,
  type TradeHorizon,
} from './types';

/**
 * Performance screener: finds stocks that are actually performing, and says
 * over which horizon (swing / short-term / long-term).
 *
 * Every input is real daily OHLCV pulled from DhanHQ. The previous version
 * scored fabricated fundamentals — one hardcoded RELIANCE profile and an
 * identical synthetic profile for all other symbols — against RSI/supertrend
 * computed from an empty candle array, so all ten symbols tied and "top
 * picks" were just universe ordering. There is no fundamentals feed wired to
 * this system, so the screener does not pretend to have one.
 */

/** Below this, an option/equity position cannot be entered or exited without
 * moving the price. ₹5 crore of daily traded value is a modest floor. */
const MIN_AVG_TRADED_VALUE = 5_00_00_000;

const HISTORY_DAYS = 400; // ~250 trading sessions plus weekends/holidays

export class StockScreener {
  async screen(
    universeId: string,
    preset: ScreenerPresetName,
    market: MarketDataProvider,
    exchange: ExchangePreference = 'NSE',
    client?: any,
    onProgress: (message: string) => void = () => {},
  ): Promise<ScreenerResult> {
    const instruments = await resolveUniverse(client ?? market.client, universeId, exchange);
    onProgress(`Resolved ${instruments.length} instruments for ${universeId} from the ${exchange} scrip master`);

    // Every relative-strength rule is measured against this. Swallowing a
    // failed fetch would leave those metrics null and silently fail every
    // candidate for a reason that has nothing to do with the stocks — two
    // runs minutes apart disagreed exactly this way during live testing.
    const benchmark = await market.getBenchmarkCandles(HISTORY_DAYS);
    if (benchmark.length < 60) {
      throw new Error(
        `Benchmark (NIFTY) history unavailable — got ${benchmark.length} candles. `
        + 'Refusing to screen: relative strength would be null for every stock.',
      );
    }
    onProgress(`Benchmark loaded: ${benchmark.length} NIFTY sessions for relative strength`);
    onProgress(`Fetching up to ${HISTORY_DAYS} days of daily candles per stock (rate-limited by the SDK)`);

    const candidates: ScreenerCandidate[] = [];
    const noHistory: string[] = [];
    const fetchFailed: string[] = [];
    let done = 0;
    for (const inst of instruments) {
      const outcome = await this.evaluateCandidate(inst, preset, market, benchmark);
      if (outcome.candidate) candidates.push(outcome.candidate);
      else if (outcome.reason === 'FETCH_FAILED') fetchFailed.push(inst.symbol);
      else noHistory.push(inst.symbol);
      done++;
      // A full F&O scan is 200+ throttled calls; without periodic progress the
      // UI looks hung for a minute or more.
      if (done % 25 === 0 || done === instruments.length) {
        onProgress(`Evaluated ${done}/${instruments.length} (${noHistory.length + fetchFailed.length} skipped)`);
      }
    }

    // A dropped fetch used to be indistinguishable from a genuinely short
    // price history, so a transient rate-limit silently changed the results
    // between two runs minutes apart. Report them separately and loudly.
    if (fetchFailed.length) {
      onProgress(`WARNING: price history could not be fetched for ${fetchFailed.length} stock(s) — `
        + `${fetchFailed.slice(0, 8).join(', ')}${fetchFailed.length > 8 ? '…' : ''}. `
        + 'These were excluded, not failed; re-run to include them.');
    }

    candidates.sort((a, b) => {
      if (a.passed !== b.passed) return a.passed ? -1 : 1;
      return b.deterministicScore - a.deterministicScore;
    });

    const passedList = candidates.filter((c) => c.passed);
    return {
      universe: universeId,
      exchange,
      preset,
      totalScreened: candidates.length,
      totalPassed: passedList.length,
      skipped: noHistory.length + fetchFailed.length,
      skippedNoHistory: noHistory,
      skippedFetchFailed: fetchFailed,
      candidates,
      topPicks: passedList.slice(0, 5).map((c) => c.symbol),
      screenedAt: Date.now(),
    };
  }

  /** Never scores a candidate off partial data. Distinguishes a failed fetch
   * from a genuinely short history so a transient API error is not silently
   * reported as "this stock is too new". */
  private async evaluateCandidate(
    inst: InstrumentRef,
    preset: ScreenerPresetName,
    market: MarketDataProvider,
    benchmark: Candle[],
  ): Promise<{ candidate?: ScreenerCandidate; reason?: 'NO_HISTORY' | 'FETCH_FAILED' }> {
    let candles: Candle[] = [];
    let failed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        candles = await market.getHistoricalCandles(inst, HISTORY_DAYS);
        failed = false;
        break;
      } catch {
        failed = true;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 400)); // one retry: usually a rate-limit blip
      }
    }
    if (failed) return { reason: 'FETCH_FAILED' };

    const metrics = computePerformance(candles, benchmark);
    if (!metrics) return { reason: 'NO_HISTORY' };

    const horizons = classifyHorizons(metrics);
    const { passedRules, failedRules } = this.checkPresetRules(preset, metrics, horizons);

    return { candidate: {
      symbol: inst.symbol,
      name: inst.name || inst.symbol,
      sector: inst.sector || 'Unclassified',
      securityId: inst.securityId,
      exchangeSegment: inst.exchangeSegment,
      cmp: metrics.close,
      deterministicScore: performanceScore(metrics, horizons),
      passed: failedRules.length === 0,
      passedRules,
      failedRules,
      horizons,
      metrics,
    } };
  }

  private checkPresetRules(
    preset: ScreenerPresetName,
    m: PerformanceMetrics,
    horizons: TradeHorizon[],
  ): { passedRules: string[]; failedRules: string[] } {
    const passedRules: string[] = [];
    const failedRules: string[] = [];
    const test = (rule: string, ok: boolean) => (ok ? passedRules : failedRules).push(rule);

    test('Liquidity >= ₹5cr avg daily value', m.avgTradedValue >= MIN_AVG_TRADED_VALUE);

    if (preset === 'MOMENTUM_BREAKOUT') {
      test('Qualifies for SWING horizon', horizons.includes('SWING'));
      test('Within 10% of 52-week high', (m.pctFrom52wHigh ?? -100) > -10);
      test('20d return positive', (m.return20d ?? 0) > 0);
    } else if (preset === 'QUALITY_COMPOUNDERS') {
      test('Qualifies for LONG_TERM horizon', horizons.includes('LONG_TERM'));
      test('Outperforming index over 1 year', (m.relativeStrength250d ?? 0) > 0);
      test('Above rising 200DMA', m.sma200Rising === true && m.sma200 != null && m.close > m.sma200);
    } else if (preset === 'VALUE_MARGIN_OF_SAFETY') {
      // Price-based analogue of "value": still in a primary uptrend, but
      // bought after a pullback rather than at the highs.
      test('Above 200DMA (primary uptrend intact)', m.sma200 != null && m.close > m.sma200);
      test('At least 8% below 52-week high', (m.pctFrom52wHigh ?? 0) < -8);
      test('Not in freefall (60d return > -15%)', (m.return60d ?? 0) > -15);
    } else {
      // OPTIONS_BULLISH — tradable in options over the next few weeks.
      test('Qualifies for SHORT_TERM horizon', horizons.includes('SHORT_TERM'));
      test('Outperforming index over 60d', (m.relativeStrength60d ?? 0) > 0);
      test('Volatility under 5% daily', (m.volatilityPct ?? 99) < 5);
    }

    return { passedRules, failedRules };
  }
}
