import { marketClock, nearestIndexExpiry } from '../services/marketHours';
import { isTradingHoliday, hasHolidayCoverage } from '../services/holidays';

describe('holiday calendar', () => {
  it('flags a known 2026 NSE/BSE trading holiday', () => {
    expect(isTradingHoliday('2026-03-31')).toBe(true); // Shri Mahavir Jayanti
  });

  it('does not flag an ordinary trading Tuesday', () => {
    expect(isTradingHoliday('2026-01-06')).toBe(false);
  });

  it('reports coverage for a year present in the table and not for one absent', () => {
    expect(hasHolidayCoverage('2026-06-01')).toBe(true);
    expect(hasHolidayCoverage('2031-06-01')).toBe(false);
  });
});

describe('marketClock — holiday awareness', () => {
  it('reports the market closed on a trading holiday even during regular session hours', () => {
    // 2026-03-31 10:30 IST = 05:00 UTC same day — inside 09:15-15:30 IST by the clock, but a holiday.
    const clock = marketClock(new Date('2026-03-31T05:00:00Z'));
    expect(clock.istDate).toBe('2026-03-31');
    expect(clock.isTradingHoliday).toBe(true);
    expect(clock.isTradingDay).toBe(false);
    expect(clock.isMarketOpen).toBe(false);
    expect(clock.squareOffWindow).toBe(false);
  });

  it('reports the market open at the same wall-clock time on a non-holiday trading day', () => {
    // 2026-01-06 is a Tuesday, not a holiday.
    const clock = marketClock(new Date('2026-01-06T05:00:00Z'));
    expect(clock.isTradingHoliday).toBe(false);
    expect(clock.isTradingDay).toBe(true);
    expect(clock.isMarketOpen).toBe(true);
  });
});

describe('nearestIndexExpiry', () => {
  it('rolls forward a full week once the 15:30 IST cutoff has passed, even at minutes < 30', () => {
    // 2026-01-06 is a Tuesday (NIFTY's expiry weekday). 16:05 IST = 10:35 UTC —
    // past close. The old `hours>=15 && minutes>=30` check read this as NOT
    // past cutoff (minutes=5 < 30) and would incorrectly return the SAME
    // Tuesday whose session had already ended.
    const expiry = nearestIndexExpiry('NIFTY', new Date('2026-01-06T10:35:00Z'));
    expect(expiry).toBe('2026-01-13'); // next Tuesday, not the one that just closed
  });

  it('does not roll forward before the cutoff on expiry day itself', () => {
    // Same Tuesday, 10:00 IST (04:30 UTC) — market open, expiry is today.
    const expiry = nearestIndexExpiry('NIFTY', new Date('2026-01-06T04:30:00Z'));
    expect(expiry).toBe('2026-01-06');
  });

  it('prepones a weekly expiry off a holiday to the previous trading day', () => {
    // Asking on Wednesday 2026-03-25: the next Tuesday is 2026-03-31, which
    // is Shri Mahavir Jayanti (a trading holiday) — expiry must be the
    // Monday before it (2026-03-30), not a date the market never opens on.
    const expiry = nearestIndexExpiry('NIFTY', new Date('2026-03-25T05:00:00Z'));
    expect(expiry).toBe('2026-03-30');
  });

  it('BANKNIFTY monthly expiry also prepones off a holiday', () => {
    // Any BANKNIFTY month-end expiry landing on a holiday must roll back;
    // spot-check that the resolved date is never itself a holiday.
    const expiry = nearestIndexExpiry('BANKNIFTY', new Date('2026-03-01T05:00:00Z'));
    expect(isTradingHoliday(expiry)).toBe(false);
  });
});
