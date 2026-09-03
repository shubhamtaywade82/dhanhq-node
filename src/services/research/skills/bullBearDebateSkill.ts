import type { OllamaClient } from '@nemesis-oss/ollama-sdk';
import type { EvidenceLedger } from '../evidenceLedger';
import type { BullBearDebate, BusinessMoatResult, FinancialValuationResult, GrowthManagementResult } from '../types';

/**
 * Adversarial Bull vs Bear debate engine with independent Debate Judge evaluation.
 * Challenges investment hypotheses against empirical evidence.
 */
export class BullBearDebateSkill {
  constructor(private ollama?: OllamaClient | null, private model = 'qwen2.5:0.5b') {}

  async conductDebate(
    symbol: string,
    business: BusinessMoatResult,
    financials: FinancialValuationResult,
    growth: GrowthManagementResult,
    ledger: EvidenceLedger,
  ): Promise<BullBearDebate> {
    const bullThesis = this.formulateBullCase(symbol, business, financials, growth);
    const bearThesis = this.formulateBearCase(symbol, financials, growth);
    const thesisBreakers = this.identifyThesisBreakers(financials, growth);

    let judgeVerdict = this.deterministicJudge(bullThesis, bearThesis, financials.dcf.marginOfSafetyPct);

    // If Ollama is available, enhance the debate evaluation
    if (this.ollama) {
      judgeVerdict = await this.evaluateWithLlm(symbol, bullThesis, bearThesis, judgeVerdict);
    }

    ledger.record({
      category: 'risk',
      claim: `Debate Judge conclusion: ${judgeVerdict.slice(0, 100)}`,
      metric: 'debate_outcome',
      source: 'adversarial_debate',
      confidence: 0.9,
    });

    return {
      bullThesis,
      bullCatalysts: ['Operating leverage expansion', 'Market share consolidation', 'FCF yield compounding'],
      bearThesis,
      bearRedFlags: growth.redFlags.length > 0 ? growth.redFlags : ['Valuation premium limits multiple expansion'],
      judgeVerdict,
      thesisBreakers,
    };
  }

  private formulateBullCase(symbol: string, business: BusinessMoatResult, fin: FinancialValuationResult, growth: GrowthManagementResult): string[] {
    return [
      `Durable competitive moat (Score: ${business.moat.aggregateScore}/100) and pricing power protect margins.`,
      `Quality cash generation: CFO/PAT ratio of ${fin.cfoVsPatRatio}x and ${fin.fcfConversionPct}% FCF conversion.`,
      `Growth headroom: Industry TAM growing at ${growth.industryTamCagrPct}% CAGR with strong capital efficiency (ROIC ${fin.roicPct}%).`,
    ];
  }

  private formulateBearCase(symbol: string, fin: FinancialValuationResult, growth: GrowthManagementResult): string[] {
    const points: string[] = [];
    if (fin.dcf.marginOfSafetyPct < 0) {
      points.push(`Current market price carries negative margin of safety (${fin.dcf.marginOfSafetyPct}%), pricing in aggressive growth.`);
    } else {
      points.push(`Relative valuation: Trades at ${fin.peerMultiples.pe}x P/E vs sector average of ${fin.peerMultiples.sectorPe}x.`);
    }
    if (growth.guidanceExecutionGapPct < 0) {
      points.push(`Execution risk: Management underdelivered past guidance by ${growth.guidanceExecutionGapPct}%.`);
    }
    points.push('Macro headwind risk: Commodity input shocks or systemic interest rate tightening could compress margins.');
    return points;
  }

  private identifyThesisBreakers(fin: FinancialValuationResult, growth: GrowthManagementResult): string[] {
    return [
      'Two consecutive quarters of CFO falling below 70% of PAT',
      'Promoter share pledging exceeding 10%',
      `Gross margin compression exceeding 300 bps YoY`,
      `Stock price sustaining 25% below DCF Bear Fair Value (₹${fin.dcf.bearFairValue})`,
    ];
  }

  private deterministicJudge(bull: string[], bear: string[], marginOfSafety: number): string {
    if (marginOfSafety >= 15) {
      return 'Bull case dominates: Favorable valuation margin of safety combined with durable economic moat provides attractive risk/reward asymmetric payoff.';
    }
    if (marginOfSafety < -15) {
      return 'Bear case prevails on valuation grounds: Despite strong business quality, entry price lacks downside margin of safety.';
    }
    return 'Balanced risk/reward: Solid franchise fundamentals offset by fair current market valuation. Accumulate on dips.';
  }

  private async evaluateWithLlm(symbol: string, bull: string[], bear: string[], fallback: string): Promise<string> {
    try {
      const prompt = `As an adversarial debate judge for Indian stock ${symbol}, evaluate:
BULL CASE: ${bull.join(' ')}
BEAR CASE: ${bear.join(' ')}
State which side has stronger empirical support in 2 concise sentences.`;

      const res = await this.ollama!.chatText({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are an objective institutional equity research debate judge.' },
          { role: 'user', content: prompt },
        ],
        options: { temperature: 0.2 },
      });
      return res.trim() || fallback;
    } catch {
      return fallback;
    }
  }
}
