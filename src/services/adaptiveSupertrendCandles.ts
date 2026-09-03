import type { DhanClient, Candle } from '@nemesis-oss/dhanhq-sdk';
import { candlesFromSeries, resample } from '@nemesis-oss/dhanhq-sdk';
import { istParts } from './marketHours';

const MAX_BUFFERED_CANDLES = 300;
const FIVE_MIN_SECONDS = 5 * 60;

/**
 * Rolling 1m candle buffer per symbol, with a 5m view derived from it.
 *
 * DhanHQ's intraday endpoint has no incremental cursor — a full same-day
 * refetch (<=375 rows for a full session) every poll is simpler and safer
 * than hand-rolled incremental append/dedup, and cheap enough not to matter
 * at a 60s poll cadence.
 */
export class CandleStore {
  private oneMinute = new Map<string, Candle[]>();

  constructor(private client: DhanClient) {}

  async refresh(symbol: string, securityId: string): Promise<void> {
    const today = istParts().dateStr;
    const series = await this.client.charts.intraday({
      securityId, exchangeSegment: 'IDX_I', instrument: 'INDEX',
      interval: '1', fromDate: today, toDate: today,
    });
    const candles = candlesFromSeries(series).slice(-MAX_BUFFERED_CANDLES);
    this.oneMinute.set(symbol, candles);
  }

  getOneMinute(symbol: string): Candle[] {
    return this.oneMinute.get(symbol) ?? [];
  }

  /** resample() only floors timestamps into 5m buckets — it doesn't know
   * whether the newest bucket has actually seen all 5 of its 1m bars yet.
   * Trading on an in-progress bucket makes the 5m direction flicker as
   * later 1m bars arrive, so the trailing bucket is dropped unless it's
   * backed by a full 5 minutes of 1m candles. */
  getFiveMinute(symbol: string): Candle[] {
    const oneMin = this.getOneMinute(symbol);
    const fiveMin = resample(oneMin, 5);
    if (fiveMin.length === 0) return fiveMin;

    const lastBucketStart = fiveMin[fiveMin.length - 1]!.timestamp;
    const barsInLastBucket = oneMin.filter(
      (c) => c.timestamp >= lastBucketStart && c.timestamp < lastBucketStart + FIVE_MIN_SECONDS,
    ).length;
    return barsInLastBucket >= 5 ? fiveMin : fiveMin.slice(0, -1);
  }
}
