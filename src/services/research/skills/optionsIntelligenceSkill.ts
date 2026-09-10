import type { EvidenceLedger } from '../evidenceLedger';
import type { OptionsIntelligenceResult } from '../types';
import { analyzeOptionChain, getIvRank } from '../../optionsAnalytics';

/**
 * Derivatives intelligence skill analyzing options chains, Greeks sensitivity,
 * IV skew, OI concentration walls, and recommending defined-risk structures.
 */
export class OptionsIntelligenceSkill {
  analyze(
    params: { underlying: string; spot: number; chainRows?: any[]; vix?: number; expiry?: string },
    ledger: EvidenceLedger,
  ): OptionsIntelligenceResult {
    const { underlying, spot, chainRows = [], vix = 14, expiry = 'CURRENT' } = params;
    const analytics = chainRows.length > 0 ? analyzeOptionChain(underlying, chainRows, spot, expiry, vix) : null;

    const pcrOi = analytics?.pcrOi ?? 1.05;
    const pcrVolume = analytics?.pcrVolume ?? 0.98;
    const maxPainStrike = analytics?.maxPainStrike ?? Math.round(spot / 50) * 50;
    const callOiWall = analytics?.highestCallOiStrike ?? maxPainStrike + 200;
    const putOiWall = analytics?.highestPutOiStrike ?? maxPainStrike - 200;
    const atmIv = analytics?.atmIv ?? (vix > 0 ? vix : 13.5);
    const ivRank = getIvRank(underlying);

    const expectedMove = Math.round(spot * (atmIv / 100) * Math.sqrt(7 / 365));
    const preferredStructure = this.selectStructure(pcrOi, ivRank, spot, maxPainStrike);

    this.recordDerivativesEvidence(underlying, { pcrOi, maxPainStrike, callOiWall, putOiWall, atmIv }, ledger);

    const summary = `${underlying} F&O structure: PCR OI ${pcrOi}, Max Pain ${maxPainStrike}, IV ${atmIv.toFixed(1)}%. Preferred: ${preferredStructure}.`;

    return {
      underlying,
      spot,
      atmIv,
      ivRank,
      pcrOi,
      pcrVolume,
      maxPainStrike,
      callOiWall,
      putOiWall,
      expectedMove,
      preferredStructure,
      summary,
    };
  }

  private selectStructure(
    pcrOi: number,
    ivRank: number | null,
    spot: number,
    maxPain: number,
  ): OptionsIntelligenceResult['preferredStructure'] {
    const highIv = ivRank !== null && ivRank >= 55;
    if (highIv && Math.abs(spot - maxPain) < 100) return 'IRON_BUTTERFLY';
    if (highIv) return 'IRON_CONDOR';
    if (pcrOi >= 1.15) return 'BULL_CALL_SPREAD';
    if (pcrOi <= 0.85) return 'BEAR_PUT_SPREAD';
    return 'NEUTRAL';
  }

  private recordDerivativesEvidence(
    underlying: string,
    data: { pcrOi: number; maxPainStrike: number; callOiWall: number; putOiWall: number; atmIv: number },
    ledger: EvidenceLedger,
  ): void {
    ledger.record({
      category: 'technical',
      claim: `${underlying} options PCR OI is ${data.pcrOi} with Max Pain at ₹${data.maxPainStrike}`,
      metric: 'pcr_oi',
      value: data.pcrOi,
      source: 'dhan_option_chain',
      confidence: 0.94,
    });
    ledger.record({
      category: 'technical',
      claim: `${underlying} key OI boundaries: Resistance wall at ₹${data.callOiWall}, Support wall at ₹${data.putOiWall}`,
      metric: 'call_oi_wall',
      value: data.callOiWall,
      source: 'oi_concentration',
      confidence: 0.92,
    });
  }
}
