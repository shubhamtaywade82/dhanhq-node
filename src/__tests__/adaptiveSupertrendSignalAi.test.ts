import { FuzzySignalAI } from '../services/adaptiveSupertrend/signalAi';
import type { MarketFeatures, SupertrendParams } from '../services/adaptiveSupertrend/types';

const params: SupertrendParams = { atrPeriod: 10, multiplier: 2.0 };

function features(overrides: Partial<MarketFeatures> = {}): MarketFeatures {
  return {
    volatility: 'medium', trendStrength: 'medium', momentum: 'neutral',
    adx: 25, bandWidth: 0.04, rsi: 55, macdHist: 0, volumeRatio: 1, atr: 10,
    ...overrides,
  };
}

describe('adaptive supertrend fuzzy signal', () => {
  const ai = new FuzzySignalAI();

  it('opens long on a fresh bullish crossover with strong RSI/MACD confluence', () => {
    const signal = ai.generateSignal({
      stDirection: 1, isCrossover: true, params, currentPrice: 100, supertrendValue: 95,
      features: features({ rsi: 65, macdHist: 1 }),
    });
    expect(signal.action).toBe('OPEN_LONG');
    expect(signal.confidence).toBeGreaterThanOrEqual(0.55);
    expect(signal.stopLossPrice).toBeLessThan(100);
    expect(signal.takeProfitPrice).toBeGreaterThan(100);
  });

  it('opens short on a fresh bearish crossover with weak RSI/MACD confluence', () => {
    const signal = ai.generateSignal({
      stDirection: -1, isCrossover: true, params, currentPrice: 100, supertrendValue: 105,
      features: features({ rsi: 35, macdHist: -1 }),
    });
    expect(signal.action).toBe('OPEN_SHORT');
    expect(signal.confidence).toBeGreaterThanOrEqual(0.55);
    expect(signal.stopLossPrice).toBeGreaterThan(100);
    expect(signal.takeProfitPrice).toBeLessThan(100);
  });

  it('holds when confluence does not clear the confidence threshold', () => {
    // Direction is bullish but far from the Supertrend line and neutral
    // RSI/MACD — trendFreshness decays, confluence stays under 0.55.
    const signal = ai.generateSignal({
      stDirection: 1, isCrossover: false, params, currentPrice: 130, supertrendValue: 95,
      features: features({ rsi: 50, macdHist: 0 }),
    });
    expect(signal.action).toBe('HOLD');
    expect(signal.confidence).toBe(0);
  });

  it('takes the tighter of the ATR-multiple stop and the Supertrend line', () => {
    const signal = ai.generateSignal({
      stDirection: 1, isCrossover: true, params, currentPrice: 100, supertrendValue: 99,
      features: features({ rsi: 65, macdHist: 1 }), slAtrMult: 1.5,
    });
    // slAtrMult*atr = 15 -> raw SL = 85; min(supertrendValue=99, 85) = 85.
    expect(signal.action).toBe('OPEN_LONG');
    expect(signal.stopLossPrice).toBe(85);
  });
});
