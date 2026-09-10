import type { BullBearDebate, BusinessMoatResult, FinancialValuationResult, GrowthManagementResult, InvestmentVerdict, TechnicalRiskResult, VerdictStance } from '../types';

/**
 * Final synthesis engine that derives institutional BUY / HOLD / AVOID decisions.
 * Crucially separates Business Quality from Current Valuation.
 */
export interface VerdictInputs {
  business: BusinessMoatResult;
  financials: FinancialValuationResult;
  growth: GrowthManagementResult;
  technical: TechnicalRiskResult;
  debate: BullBearDebate;
}

export class VerdictSkill {
  synthesize(symbol: string, inputs: VerdictInputs): InvestmentVerdict {
    const { business, financials, growth, technical, debate } = inputs;
    const qualityScore = this.computeQualityScore(business.moat.aggregateScore, financials.earningsQualityPass, financials.roicPct, growth.governanceScore);
    const valuationScore = financials.valuationScore;
    const compositeScore = Math.round(qualityScore * 0.6 + valuationScore * 0.4);

    const stance = this.determineStance(qualityScore, valuationScore, growth.redFlags.length);
    const expectedCagr = this.projectCagr(stance, financials.dcf.marginOfSafetyPct, growth.companyRevenueCagr3y);

    const summary = `${symbol} rating: ${stance} (Quality: ${qualityScore}/100, Valuation: ${valuationScore}/100, Composite: ${compositeScore}/100). Base DCF Fair Value ₹${financials.dcf.baseFairValue} (Margin of Safety: ${financials.dcf.marginOfSafetyPct}%).`;

    return {
      stance,
      qualityScore,
      valuationScore,
      compositeScore,
      fairValue: {
        bear: financials.dcf.bearFairValue,
        base: financials.dcf.baseFairValue,
        bull: financials.dcf.bullFairValue,
      },
      marginOfSafetyPct: financials.dcf.marginOfSafetyPct,
      expectedCagr,
      keyCatalysts: debate.bullCatalysts,
      keyRisks: technical.riskRegister.map((r) => `${r.category}: ${r.risk}`),
      thesisBreakers: debate.thesisBreakers,
      confidence: qualityScore >= 75 ? 0.88 : 0.75,
      summary,
    };
  }

  private computeQualityScore(moatScore: number, earningsQuality: boolean, roic: number, govScore: number): number {
    let score = (moatScore * 0.35) + (govScore * 0.35) + (Math.min(100, roic * 4) * 0.30);
    if (!earningsQuality) score -= 15; // Penalty for poor cash-flow conversion or high leverage
    return Math.round(Math.max(10, Math.min(98, score)));
  }

  private determineStance(quality: number, valuation: number, redFlagCount: number): VerdictStance {
    if (redFlagCount > 1 || quality < 55) return 'AVOID';
    if (quality >= 70 && valuation >= 60) return 'BUY';
    if (quality >= 60 && valuation >= 40) return 'HOLD';
    return 'AVOID';
  }

  private projectCagr(stance: VerdictStance, marginOfSafety: number, revenueCagr: number) {
    const baseCagr = Math.max(5, Math.min(25, revenueCagr));
    if (stance === 'BUY') {
      return {
        horizon1yPct: Number((baseCagr + Math.max(0, marginOfSafety * 0.5)).toFixed(1)),
        horizon3yPct: Number((baseCagr + 4).toFixed(1)),
        horizon5yPct: Number((baseCagr + 2).toFixed(1)),
      };
    }
    if (stance === 'HOLD') {
      return {
        horizon1yPct: Number((baseCagr * 0.8).toFixed(1)),
        horizon3yPct: Number((baseCagr * 0.9).toFixed(1)),
        horizon5yPct: Number((baseCagr).toFixed(1)),
      };
    }
    return {
      horizon1yPct: -5.0,
      horizon3yPct: 3.0,
      horizon5yPct: 6.0,
    };
  }
}
