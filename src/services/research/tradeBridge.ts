import type { InvestmentVerdict, OptionsIntelligenceResult, ResearchTradeSignal } from './types';

/**
 * Transforms fundamental equity research conviction and options structure
 * into an actionable, advisory trade setup signal for the trading engine.
 */
export class ResearchTradeBridge {
  generateSignal(
    symbol: string,
    verdict: InvestmentVerdict,
    options?: OptionsIntelligenceResult,
  ): ResearchTradeSignal {
    const bias = this.determineBias(verdict.stance, verdict.marginOfSafetyPct);
    const conviction = verdict.compositeScore;
    const horizon = this.resolveHorizon(symbol);
    const entryConditions = this.buildEntryConditions(bias, verdict, options);
    const invalidationTriggers = this.buildInvalidations(verdict, options);
    const suggestedStructures = this.recommendStructures(bias, options);

    return {
      symbol: symbol.toUpperCase(),
      bias,
      conviction,
      horizon,
      fairValue: verdict.fairValue,
      marginOfSafetyPct: verdict.marginOfSafetyPct,
      entryConditions,
      invalidationTriggers,
      suggestedStructures,
      generatedAt: Date.now(),
    };
  }

  private determineBias(stance: InvestmentVerdict['stance'], marginOfSafety: number): ResearchTradeSignal['bias'] {
    if (stance === 'BUY' && marginOfSafety >= 0) return 'BULLISH';
    if (stance === 'AVOID' && marginOfSafety < -10) return 'BEARISH';
    return 'NEUTRAL';
  }

  private resolveHorizon(symbol: string): ResearchTradeSignal['horizon'] {
    const isIndex = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'MIDCPNIFTY'].includes(symbol.toUpperCase());
    return isIndex ? 'INTRADAY' : 'SWING';
  }

  private buildEntryConditions(
    bias: ResearchTradeSignal['bias'],
    verdict: InvestmentVerdict,
    options?: OptionsIntelligenceResult,
  ): string[] {
    const conditions: string[] = [];
    if (bias === 'BULLISH') {
      conditions.push(`Spot holding above Bear Fair Value floor (₹${verdict.fairValue.bear})`);
      if (options?.putOiWall) conditions.push(`Respecting put OI support boundary at ₹${options.putOiWall}`);
      conditions.push('15m/1h trend alignment with positive RSI momentum (> 48)');
    } else if (bias === 'BEARISH') {
      conditions.push(`Break of key support level below ₹${verdict.fairValue.base}`);
      if (options?.callOiWall) conditions.push(`Rejection at call OI resistance wall of ₹${options.callOiWall}`);
    } else {
      conditions.push(`Range-bound consolidation between ₹${verdict.fairValue.bear} and ₹${verdict.fairValue.bull}`);
    }
    return conditions;
  }

  private buildInvalidations(verdict: InvestmentVerdict, options?: OptionsIntelligenceResult): string[] {
    const triggers = [...verdict.thesisBreakers];
    if (options?.putOiWall) triggers.push(`Definitive breach below Put OI wall at ₹${options.putOiWall}`);
    return triggers;
  }

  private recommendStructures(bias: ResearchTradeSignal['bias'], options?: OptionsIntelligenceResult): string[] {
    if (options?.preferredStructure && options.preferredStructure !== 'NEUTRAL') {
      return [options.preferredStructure];
    }
    if (bias === 'BULLISH') return ['BULL_CALL_SPREAD', 'LONG_CALL_ORB'];
    if (bias === 'BEARISH') return ['BEAR_PUT_SPREAD', 'LONG_PUT_ORB'];
    return ['IRON_CONDOR', 'RANGE_BOUND_CREDIT_SPREAD'];
  }
}
