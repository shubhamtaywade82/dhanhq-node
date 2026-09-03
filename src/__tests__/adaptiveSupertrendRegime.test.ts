import { extractMarketFeatures, formatRegimeKey } from '../services/adaptiveSupertrend/regime';
import type { Candle } from '@nemesis-oss/dhanhq-sdk';

function makeCandle(i: number, close: number, volume = 0): Candle {
  return { timestamp: 1_700_000_000 + i * 60, open: close, high: close + 1, low: close - 1, close, volume };
}

/** Strong, steady uptrend — high ADX, elevated RSI, expanding bands. */
function trendingUpCandles(n = 50): Candle[] {
  return Array.from({ length: n }, (_, i) => makeCandle(i, 100 + i * 3, i % 7));
}

/** Flat/ranging noise — low ADX, mid RSI, tight bands. */
function rangingCandles(n = 50): Candle[] {
  return Array.from({ length: n }, (_, i) => makeCandle(i, 100 + (i % 2 === 0 ? 0.3 : -0.3), i % 7));
}

describe('adaptive supertrend regime extraction', () => {
  it('returns null with fewer than 35 candles', () => {
    expect(extractMarketFeatures(trendingUpCandles(34))).toBeNull();
  });

  it('classifies a steady uptrend as strong trend / overbought momentum', () => {
    const features = extractMarketFeatures(trendingUpCandles());
    expect(features).not.toBeNull();
    expect(features!.trendStrength).toBe('strong');
    expect(features!.momentum).toBe('overbought');
  });

  it('classifies flat ranging candles as weak trend / low volatility', () => {
    const features = extractMarketFeatures(rangingCandles());
    expect(features).not.toBeNull();
    expect(features!.trendStrength).toBe('weak');
    expect(features!.volatility).toBe('low');
  });

  it('always hardcodes volumeRatio to 1 regardless of candle volume content', () => {
    const zeroVolume = trendingUpCandles().map((c) => ({ ...c, volume: 0 }));
    const highVolume = trendingUpCandles().map((c) => ({ ...c, volume: 999_999 }));
    expect(extractMarketFeatures(zeroVolume)!.volumeRatio).toBe(1);
    expect(extractMarketFeatures(highVolume)!.volumeRatio).toBe(1);
  });

  it('formats the regime key as volatility_trendStrength_momentum', () => {
    const features = extractMarketFeatures(trendingUpCandles())!;
    expect(formatRegimeKey(features)).toBe(`${features.volatility}_${features.trendStrength}_${features.momentum}`);
  });
});
