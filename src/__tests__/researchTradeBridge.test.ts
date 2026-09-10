import { ResearchTradeBridge } from '../services/research/tradeBridge';
import type { InvestmentVerdict, OptionsIntelligenceResult } from '../services/research/types';

describe('ResearchTradeBridge', () => {
  let bridge: ResearchTradeBridge;

  beforeEach(() => {
    bridge = new ResearchTradeBridge();
  });

  const mockVerdict: InvestmentVerdict = {
    stance: 'BUY',
    qualityScore: 88,
    valuationScore: 72,
    compositeScore: 82,
    fairValue: { bear: 2200, base: 2800, bull: 3400 },
    marginOfSafetyPct: 15.5,
    expectedCagr: { horizon1yPct: 18, horizon3yPct: 16, horizon5yPct: 15 },
    keyCatalysts: ['Strong retail margin expansion'],
    keyRisks: ['Oil price volatility'],
    thesisBreakers: ['Sustained quarterly CFO drop > 20%'],
    confidence: 0.92,
    summary: 'Strong Buy rating with 15.5% margin of safety',
  };

  const mockOptions: OptionsIntelligenceResult = {
    underlying: 'RELIANCE',
    spot: 2420,
    atmIv: 16.5,
    ivRank: 35,
    pcrOi: 1.25,
    pcrVolume: 1.15,
    maxPainStrike: 2450,
    callOiWall: 2500,
    putOiWall: 2380,
    expectedMove: 55,
    preferredStructure: 'BULL_CALL_SPREAD',
    summary: 'F&O bullish bias',
  };

  it('generates BULLISH advisory trade signal for high quality BUY verdict with positive margin of safety', () => {
    const signal = bridge.generateSignal('RELIANCE', mockVerdict, mockOptions);

    expect(signal.symbol).toBe('RELIANCE');
    expect(signal.bias).toBe('BULLISH');
    expect(signal.conviction).toBe(82);
    expect(signal.horizon).toBe('SWING');
    expect(signal.suggestedStructures).toContain('BULL_CALL_SPREAD');
    expect(signal.entryConditions.some((c) => c.includes('Bear Fair Value'))).toBe(true);
    expect(signal.invalidationTriggers.some((t) => t.includes('Put OI wall'))).toBe(true);
  });

  it('generates BEARISH advisory trade signal when stance is AVOID with negative margin of safety', () => {
    const avoidVerdict: InvestmentVerdict = {
      ...mockVerdict,
      stance: 'AVOID',
      marginOfSafetyPct: -25.0,
      compositeScore: 42,
    };

    const signal = bridge.generateSignal('TCS', avoidVerdict);

    expect(signal.symbol).toBe('TCS');
    expect(signal.bias).toBe('BEARISH');
    expect(signal.suggestedStructures).toContain('BEAR_PUT_SPREAD');
  });

  it('sets INTRADAY horizon for index instruments', () => {
    const signal = bridge.generateSignal('NIFTY', mockVerdict, mockOptions);
    expect(signal.horizon).toBe('INTRADAY');
  });
});
