import { resolveNearestExpiry } from '../services/strategyConstructor';
import { nearestIndexExpiry } from '../services/marketHours';

// Each test uses a distinct index symbol — resolveNearestExpiry's expiry-list
// cache is module-level and keyed by symbol, so this avoids cross-test cache
// pollution without needing to export a cache-reset hook just for tests.

function stubClient(expiryListImpl: (...args: any[]) => any) {
  return { optionChain: { expiryList: jest.fn(expiryListImpl) } } as any;
}

describe('resolveNearestExpiry', () => {
  it('returns the nearest upcoming date from the live expiry list', async () => {
    const client = stubClient(async () => ({ data: ['2026-01-06', '2026-01-13', '2026-01-20'] }));
    const expiry = await resolveNearestExpiry(client, 'NIFTY', new Date('2026-01-01T05:00:00Z'));
    expect(expiry).toBe('2026-01-06');
  });

  it('excludes today once the 15:30 IST cutoff has passed, even if it is in the list', async () => {
    const client = stubClient(async () => ({ data: ['2026-01-06', '2026-01-13'] }));
    // 16:05 IST on 2026-01-06 — that day's expiry has already closed.
    const expiry = await resolveNearestExpiry(client, 'BANKNIFTY', new Date('2026-01-06T10:35:00Z'));
    expect(expiry).toBe('2026-01-13');
  });

  it('includes today when still before cutoff', async () => {
    const client = stubClient(async () => ({ data: ['2026-01-06', '2026-01-13'] }));
    const expiry = await resolveNearestExpiry(client, 'FINNIFTY', new Date('2026-01-06T04:30:00Z'));
    expect(expiry).toBe('2026-01-06');
  });

  it('falls back to the weekday heuristic when the API call throws', async () => {
    const now = new Date('2026-01-01T05:00:00Z');
    const client = stubClient(async () => { throw new Error('rate limited'); });
    const expiry = await resolveNearestExpiry(client, 'SENSEX', now);
    expect(expiry).toBe(nearestIndexExpiry('SENSEX', now));
  });

  it('falls back to the weekday heuristic when the API returns an empty list', async () => {
    const now = new Date('2026-01-01T05:00:00Z');
    const client = stubClient(async () => ({ data: [] }));
    const expiry = await resolveNearestExpiry(client, 'MIDCPNIFTY', now);
    expect(expiry).toBe(nearestIndexExpiry('MIDCPNIFTY', now));
  });

  it('caches the expiry list — a second call within TTL does not re-hit the API', async () => {
    // A distinct symbol from every other test in this file — the cache is
    // module-level and keyed by symbol, keyed to real wall-clock time (not
    // the injected `now`), so reusing a symbol another test already
    // populated would make this pass for the wrong reason (cache hit from
    // that earlier test, not from the two calls below).
    const impl = jest.fn(async () => ({ data: ['2026-02-03', '2026-02-10'] }));
    const client = { optionChain: { expiryList: impl } } as any;
    await resolveNearestExpiry(client, 'INDIAVIX', new Date('2026-02-01T05:00:00Z'));
    await resolveNearestExpiry(client, 'INDIAVIX', new Date('2026-02-01T06:00:00Z'));
    expect(impl).toHaveBeenCalledTimes(1);
  });
});
