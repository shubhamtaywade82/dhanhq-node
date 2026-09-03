import { adx, bollingerBands, macd, rsi, atr, closes, type Candle } from '@nemesis-oss/dhanhq-sdk';
import type { MarketFeatures, MarketVolatility, TrendStrength, MarketMomentum } from './types';

export function extractMarketFeatures(candles: Candle[]): MarketFeatures | null {
  if (candles.length < 35) return null;

  const closePrices = closes(candles);
  const lastIndex = candles.length - 1;

  const bbRes = bollingerBands(closePrices, { period: 20, standardDeviations: 2 });
  const adxRes = adx(candles, 14);
  const rsiRes = rsi(closePrices, 14);
  const macdRes = macd(closePrices, { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
  const atrRes = atr(candles, 14);

  const bbUpper = bbRes.upper[lastIndex];
  const bbMiddle = bbRes.middle[lastIndex];
  const bbLower = bbRes.lower[lastIndex];
  const curBw = bbUpper != null && bbLower != null && bbMiddle ? (bbUpper - bbLower) / bbMiddle : 0.03;
  const curAdx = adxRes.adx[lastIndex] ?? 15;
  const curRsi = rsiRes[lastIndex] ?? 50;
  const curMacdHist = macdRes.histogram[lastIndex] ?? 0;
  const curAtr = atrRes[lastIndex] ?? closePrices[lastIndex]! * 0.01;

  // IDX_I (spot index) candles carry no real traded volume — computing a
  // ratio against 0/absent volume would either flatten volConfirm to its
  // floor or, if the column is missing entirely, propagate NaN through the
  // fuzzy confluence and silently kill every signal. A fixed neutral value
  // lands volConfirm at a constant 0.75 (see signalAi.ts), so confluence
  // runs on Supertrend + RSI/MACD alone — no real volume signal to add.
  const volRatio = 1;

  const volatility: MarketVolatility =
    curBw < 0.025 ? 'low' : curBw < 0.06 ? 'medium' : 'high';

  const trendStrength: TrendStrength =
    curAdx < 20 ? 'weak' : curAdx < 35 ? 'medium' : 'strong';

  const momentum: MarketMomentum =
    curRsi < 32 ? 'oversold' : curRsi > 68 ? 'overbought' : 'neutral';

  return {
    volatility,
    trendStrength,
    momentum,
    adx: curAdx,
    bandWidth: curBw,
    rsi: curRsi,
    macdHist: curMacdHist,
    volumeRatio: volRatio,
    atr: curAtr,
  };
}

export function formatRegimeKey(f: MarketFeatures): string {
  return `${f.volatility}_${f.trendStrength}_${f.momentum}`;
}
