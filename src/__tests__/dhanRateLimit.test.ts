import {
  clearDhanRateLimit, dhanRateLimitRemainingSec, isDhanRateLimited, isRateLimitError,
  noteDhanRateLimit, resetDhanRateLimitForTests,
} from '../lib/dhanRateLimit';

describe('dhanRateLimit', () => {
  afterEach(() => resetDhanRateLimitForTests());

  it('detects Dhan rate-limit error messages', () => {
    expect(isRateLimitError('Dhan API rate limit exceeded (status 429) (DH-904 | Rate_Limit)')).toBe(true);
    expect(isRateLimitError('network timeout')).toBe(false);
  });

  it('blocks calls until backoff expires', () => {
    jest.useFakeTimers();
    noteDhanRateLimit({ retryAfterMs: 5000 });
    expect(isDhanRateLimited()).toBe(true);
    expect(dhanRateLimitRemainingSec()).toBeGreaterThan(0);
    jest.advanceTimersByTime(5001);
    expect(isDhanRateLimited()).toBe(false);
    jest.useRealTimers();
  });

  it('clears backoff after a successful broker call', () => {
    noteDhanRateLimit({ retryAfterMs: 30_000 });
    expect(isDhanRateLimited()).toBe(true);
    clearDhanRateLimit();
    expect(isDhanRateLimited()).toBe(false);
  });
});
