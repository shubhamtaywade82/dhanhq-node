import { OptionsIntelligenceSkill } from '../services/research/skills/optionsIntelligenceSkill';
import { EvidenceLedger } from '../services/research/evidenceLedger';

describe('OptionsIntelligenceSkill', () => {
  let skill: OptionsIntelligenceSkill;
  let ledger: EvidenceLedger;

  beforeEach(() => {
    skill = new OptionsIntelligenceSkill();
    ledger = new EvidenceLedger();
  });

  it('computes options intelligence with fallback data when chain rows are empty', () => {
    const res = skill.analyze({ underlying: 'NIFTY', spot: 24800, vix: 14.5 }, ledger);

    expect(res.underlying).toBe('NIFTY');
    expect(res.spot).toBe(24800);
    expect(res.maxPainStrike).toBe(24800);
    expect(res.atmIv).toBe(14.5);
    expect(res.pcrOi).toBeGreaterThan(0);
    expect(res.expectedMove).toBeGreaterThan(0);
    expect(ledger.count()).toBe(2);
  });

  it('selects BULL_CALL_SPREAD when PCR OI indicates bullish flow and IV is moderate', () => {
    const mockRows = [
      { strike: 24800, ce: { oi: 50000, ltp: 150, iv: 13, volume: 10000 }, pe: { oi: 90000, ltp: 140, iv: 13, volume: 15000 } },
      { strike: 25000, ce: { oi: 120000, ltp: 40, iv: 12.5, volume: 20000 }, pe: { oi: 20000, ltp: 280, iv: 13.5, volume: 5000 } },
      { strike: 24600, ce: { oi: 10000, ltp: 290, iv: 13.5, volume: 5000 }, pe: { oi: 110000, ltp: 35, iv: 12.8, volume: 22000 } },
    ];

    const res = skill.analyze({ underlying: 'NIFTY', spot: 24800, chainRows: mockRows }, ledger);

    expect(res.pcrOi).toBeGreaterThan(1.1);
    expect(res.preferredStructure).toBe('BULL_CALL_SPREAD');
    expect(res.callOiWall).toBe(25000);
    expect(res.putOiWall).toBe(24600);
  });
});
