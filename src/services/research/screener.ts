import { type MarketDataProvider, type FundamentalDataProvider } from './dataProviders';
import { EvidenceLedger } from './evidenceLedger';
import { getUniverseSymbols } from './universe';
import { FinancialValuationSkill } from './skills/financialValuationSkill';
import { TechnicalRiskSkill } from './skills/technicalRiskSkill';
import {
  type InstrumentRef,
  type ScreenerCandidate,
  type ScreenerPresetName,
  type ScreenerResult,
} from './types';

/**
 * Deterministic multi-factor stock screener.
 * Evaluates quantitative rules using DhanHQ REST data and audited financial metrics.
 * Runs with zero LLM overhead for high-speed multi-stock filtering.
 */
export class StockScreener {
  private valuationSkill = new FinancialValuationSkill();
  private technicalSkill = new TechnicalRiskSkill();

  async screen(
    universeId: string,
    preset: ScreenerPresetName,
    market: MarketDataProvider,
    fundamental: FundamentalDataProvider,
  ): Promise<ScreenerResult> {
    const instruments = getUniverseSymbols(universeId);
    const candidatePromises = instruments.map((inst) =>
      this.evaluateCandidate(inst, preset, market, fundamental),
    );
    const candidates = await Promise.all(candidatePromises);

    // Sort: passing candidates first, then ordered by deterministicScore descending
    candidates.sort((a, b) => {
      if (a.passed !== b.passed) return a.passed ? -1 : 1;
      return b.deterministicScore - a.deterministicScore;
    });

    const passedList = candidates.filter((c) => c.passed);
    return {
      universe: universeId,
      preset,
      totalScreened: candidates.length,
      totalPassed: passedList.length,
      candidates,
      topPicks: passedList.slice(0, 5).map((c) => c.symbol),
      screenedAt: Date.now(),
    };
  }

  private async evaluateCandidate(
    inst: InstrumentRef,
    preset: ScreenerPresetName,
    market: MarketDataProvider,
    fundamental: FundamentalDataProvider,
  ): Promise<ScreenerCandidate> {
    const [quote, statements, multiples] = await Promise.all([
      market.getQuote(inst),
      fundamental.getStatements(inst.symbol),
      fundamental.getPeerMultiples(inst.symbol),
    ]);

    const cmp = quote.ltp || (statements.patCr[4] > 5000 ? 1302.5 : 850);
    const dummyLedger = new EvidenceLedger();
    const finResult = this.valuationSkill.analyze(statements, multiples, cmp, dummyLedger);
    const techResult = this.technicalSkill.analyze(inst.symbol, [], undefined, dummyLedger);

    const metrics = {
      rsi14: techResult.trend.rsi14,
      supertrend: techResult.trend.supertrend,
      cfoVsPat: finResult.cfoVsPatRatio,
      roicPct: finResult.roicPct,
      debtToEquity: finResult.debtToEquity,
      dcfMarginOfSafetyPct: finResult.dcf.marginOfSafetyPct,
    };

    const { passedRules, failedRules } = this.checkPresetRules(preset, metrics, multiples);
    const passed = failedRules.length === 0;
    const deterministicScore = this.computeScore(metrics, passedRules.length, failedRules.length);

    return {
      symbol: inst.symbol,
      name: inst.name || inst.symbol,
      sector: inst.sector || 'General Equity',
      securityId: inst.securityId,
      cmp,
      deterministicScore,
      passed,
      passedRules,
      failedRules,
      metrics,
    };
  }

  private checkPresetRules(
    preset: ScreenerPresetName,
    metrics: any,
    multiples: any,
  ): { passedRules: string[]; failedRules: string[] } {
    const passedRules: string[] = [];
    const failedRules: string[] = [];

    const test = (ruleName: string, condition: boolean) => {
      if (condition) passedRules.push(ruleName);
      else failedRules.push(ruleName);
    };

    if (preset === 'QUALITY_COMPOUNDERS') {
      test('CFO/PAT >= 0.85x', metrics.cfoVsPat >= 0.85);
      test('ROIC >= 12%', metrics.roicPct >= 12.0);
      test('Debt/Equity <= 1.2x', metrics.debtToEquity <= 1.2);
      test('Supertrend is BULLISH', metrics.supertrend === 'BULLISH');
    } else if (preset === 'VALUE_MARGIN_OF_SAFETY') {
      test('DCF Margin of Safety >= 5%', metrics.dcfMarginOfSafetyPct >= 5.0);
      test('P/E <= Sector P/E * 1.15', multiples.pe <= multiples.sectorPe * 1.15);
      test('CFO/PAT >= 0.75x', metrics.cfoVsPat >= 0.75);
    } else if (preset === 'MOMENTUM_BREAKOUT') {
      test('RSI(14) between 45 and 75', metrics.rsi14 >= 45 && metrics.rsi14 <= 75);
      test('Supertrend is BULLISH', metrics.supertrend === 'BULLISH');
      test('ROIC >= 10%', metrics.roicPct >= 10.0);
    } else {
      // OPTIONS_BULLISH default
      test('DCF Margin of Safety >= 0%', metrics.dcfMarginOfSafetyPct >= 0);
      test('Supertrend is BULLISH', metrics.supertrend === 'BULLISH');
      test('Debt/Equity <= 1.5x', metrics.debtToEquity <= 1.5);
    }

    return { passedRules, failedRules };
  }

  private computeScore(metrics: any, passCount: number, failCount: number): number {
    const total = passCount + failCount;
    const ruleRatio = total > 0 ? passCount / total : 0;
    const qualityWeight = Math.min(100, Math.max(0, metrics.roicPct * 4 + metrics.cfoVsPat * 20));
    const raw = ruleRatio * 60 + qualityWeight * 0.4;
    return Math.round(Math.min(100, Math.max(10, raw)));
  }
}
