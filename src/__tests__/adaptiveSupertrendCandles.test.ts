import { CandleStore } from '../services/adaptiveSupertrendCandles';

/** Builds a columnar ChartsResponse for `n` 1-minute candles starting at
 * `startTs` (epoch seconds, must already be minute-aligned). */
function makeSeries(n: number, startTs: number) {
  const timestamp: number[] = [];
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  const volume: number[] = [];
  for (let i = 0; i < n; i++) {
    const px = 100 + i;
    timestamp.push(startTs + i * 60);
    open.push(px); high.push(px + 1); low.push(px - 1); close.push(px); volume.push(0);
  }
  return { timestamp, open, high, low, close, volume };
}

function fakeClient(series: ReturnType<typeof makeSeries>): any {
  return { charts: { intraday: jest.fn().mockResolvedValue(series) } };
}

// A fixed 5-minute-aligned epoch second (2024-01-01 09:15:00 UTC bucket-aligned to :00).
const ALIGNED_START = 1_704_100_800; // divisible by 300

describe('CandleStore', () => {
  it('refresh() converts the columnar response into candles', async () => {
    const client = fakeClient(makeSeries(10, ALIGNED_START));
    const store = new CandleStore(client);
    await store.refresh('NIFTY', '13');
    expect(store.getOneMinute('NIFTY')).toHaveLength(10);
    expect(client.charts.intraday).toHaveBeenCalledWith(
      expect.objectContaining({ securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX', interval: '1' }),
    );
  });

  it('getFiveMinute drops an incomplete trailing bucket (7x1m -> exactly 1x5m, not 2)', async () => {
    const client = fakeClient(makeSeries(7, ALIGNED_START));
    const store = new CandleStore(client);
    await store.refresh('NIFTY', '13');
    expect(store.getFiveMinute('NIFTY')).toHaveLength(1);
  });

  it('getFiveMinute keeps a bucket once all 5 of its 1m bars have arrived', async () => {
    const client = fakeClient(makeSeries(10, ALIGNED_START));
    const store = new CandleStore(client);
    await store.refresh('NIFTY', '13');
    expect(store.getFiveMinute('NIFTY')).toHaveLength(2);
  });

  it('returns an empty array for a symbol never refreshed', () => {
    const store = new CandleStore(fakeClient(makeSeries(0, ALIGNED_START)));
    expect(store.getOneMinute('BANKNIFTY')).toEqual([]);
    expect(store.getFiveMinute('BANKNIFTY')).toEqual([]);
  });
});
