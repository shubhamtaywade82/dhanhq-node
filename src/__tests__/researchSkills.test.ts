import { EvidenceLedger } from '../services/research/evidenceLedger';
import { BusinessMoatSkill } from '../services/research/skills/businessMoatSkill';
import { FinancialValuationSkill } from '../services/research/skills/financialValuationSkill';
import { GrowthManagementSkill } from '../services/research/skills/growthManagementSkill';
import { TechnicalRiskSkill } from '../services/research/skills/technicalRiskSkill';
import { BullBearDebateSkill } from '../services/research/skills/bullBearDebateSkill';
import { VerdictSkill } from '../services/research/skills/verdictSkill';
import type { FinancialStatements, PeerMultiples } from '../services/research/dataProviders';

describe('Research Skills', () => {
  const mockStatements: FinancialStatements = {
    symbol: 'RELIANCE',
    revenueCr: [500000, 600000, 750000, 880000, 1000000],
    patCr: [50000, 60000, 65000, 72000, 79000],
    cfoCr: [55000, 62000, 70000, 80000, 88000],
    fcfCr: [20000, 24000, 30000, 36000, 42000],
    capexCr: [35000, 38000, 40000, 44000, 46000],
    debtCr: 300000,
    equityCr: 800000,
    cashCr: 190000,
    ebitdaCr: 175000,
    interestExpenseCr: 20000,
    promoterHoldingPct: 50.3,
    promoterPledgingPct: 0.0,
    fiiHoldingPct: 22.0,
    diiHoldingPct: 16.0,
    guidanceExecution: [{ promisedGrowth: 15, actualGrowth: 14.5 }],
  };

  const mockPeers: PeerMultiples = { pe: 25.0, sectorPe: 24.0, pb: 2.2, evEbitda: 14.0 };

  it('BusinessMoatSkill computes moat aggregate and records evidence', () => {
    const ledger = new EvidenceLedger();
    const skill = new BusinessMoatSkill();
    const res = skill.analyze('RELIANCE', ledger);

    expect(res.moat.aggregateScore).toBeGreaterThanOrEqual(70);
    expect(res.moatTrajectory).toBe('EXPANDING');
    expect(ledger.count()).toBe(2);
    expect(ledger.getByCategory('moat').length).toBe(1);
  });

  it('FinancialValuationSkill computes earnings quality and DCF values', () => {
    const ledger = new EvidenceLedger();
    const skill = new FinancialValuationSkill();
    const res = skill.analyze(mockStatements, mockPeers, 1400, ledger);

    expect(res.cfoVsPatRatio).toBeGreaterThan(1.0); // 88k / 79k = 1.11x
    expect(res.earningsQualityPass).toBe(true);
    expect(res.dcf.baseFairValue).toBeGreaterThan(res.dcf.bearFairValue);
    expect(res.dcf.bullFairValue).toBeGreaterThan(res.dcf.baseFairValue);
    expect(res.valuationScore).toBeGreaterThanOrEqual(10);
    expect(ledger.count()).toBe(3);
  });

  it('GrowthManagementSkill detects promoter pledging red flags', () => {
    const ledger = new EvidenceLedger();
    const skill = new GrowthManagementSkill();

    const stressedGov: FinancialStatements = {
      ...mockStatements,
      promoterPledgingPct: 15.0, // Critical red flag
      guidanceExecution: [{ promisedGrowth: 20, actualGrowth: 10 }], // -10% execution gap
    };

    const res = skill.analyze(stressedGov, ledger);
    expect(res.redFlags.length).toBeGreaterThanOrEqual(2);
    expect(res.capitalAllocationRating).toBe('POOR');
    expect(res.guidanceExecutionGapPct).toBe(-10);
  });

  it('TechnicalRiskSkill computes RSI and risk register', () => {
    const ledger = new EvidenceLedger();
    const skill = new TechnicalRiskSkill();
    const mockCandles = Array.from({ length: 50 }, (_, i) => ({
      close: 1000 + i * 5,
      high: 1010 + i * 5,
      low: 995 + i * 5,
      volume: 100000,
    }));

    const res = skill.analyze('RELIANCE', mockCandles, { pcrOi: 1.25, maxPain: 1200 }, ledger);
    expect(res.trend.rsi14).toBeGreaterThan(50);
    expect(res.trend.supertrend).toBe('BULLISH');
    expect(res.derivatives?.pcrOi).toBe(1.25);
    expect(res.riskRegister.length).toBeGreaterThan(0);
  });

  it('BullBearDebateSkill and VerdictSkill produce coherent investment verdict', async () => {
    const ledger = new EvidenceLedger();
    const moatSkill = new BusinessMoatSkill();
    const finSkill = new FinancialValuationSkill();
    const growthSkill = new GrowthManagementSkill();
    const techSkill = new TechnicalRiskSkill();
    const debateSkill = new BullBearDebateSkill(null); // deterministic
    const verdictSkill = new VerdictSkill();

    const business = moatSkill.analyze('RELIANCE', ledger);
    const financials = finSkill.analyze(mockStatements, mockPeers, 1200, ledger);
    const growth = growthSkill.analyze(mockStatements, ledger);
    const tech = techSkill.analyze('RELIANCE', [], undefined, ledger);

    const debate = await debateSkill.conductDebate('RELIANCE', business, financials, growth, ledger);
    expect(debate.bullThesis.length).toBeGreaterThan(0);
    expect(debate.bearThesis.length).toBeGreaterThan(0);
    expect(debate.thesisBreakers.length).toBeGreaterThan(0);

    const verdict = verdictSkill.synthesize('RELIANCE', { business, financials, growth, technical: tech, debate });
    expect(['BUY', 'HOLD', 'AVOID']).toContain(verdict.stance);
    expect(verdict.qualityScore).toBeGreaterThanOrEqual(50);
    expect(verdict.compositeScore).toBeGreaterThanOrEqual(50);
    expect(verdict.expectedCagr.horizon5yPct).toBeGreaterThan(0);
  });
});
