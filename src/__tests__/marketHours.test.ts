import { marketClock, nearestIndexExpiry, isWsMarketWindowOpen, getWsMarketWindow, msUntilNextWsWindow } from '../services/marketHours';
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

describe('WebSocket market hours gating', () => {
  it('allows NSE WebSocket connections starting 5m before market open (09:10 IST)', () => {
    // 2026-01-06 (Tuesday, trading day)
    // 09:09 IST = 03:39 UTC -> closed
    expect(isWsMarketWindowOpen(false, new Date('2026-01-06T03:39:00Z'))).toBe(false);
    // 09:10 IST = 03:40 UTC -> open
    expect(isWsMarketWindowOpen(false, new Date('2026-01-06T03:40:00Z'))).toBe(true);
    // 12:00 IST = 06:30 UTC -> open
    expect(isWsMarketWindowOpen(false, new Date('2026-01-06T06:30:00Z'))).toBe(true);
    // 15:35 IST = 10:05 UTC -> open (cutoff boundary)
    expect(isWsMarketWindowOpen(false, new Date('2026-01-06T10:05:00Z'))).toBe(true);
    // 15:36 IST = 10:06 UTC -> closed
    expect(isWsMarketWindowOpen(false, new Date('2026-01-06T10:06:00Z'))).toBe(false);
  });

  it('extends WebSocket hours for MCX until 23:35 IST', () => {
    // 2026-01-06 08:54 IST = 03:24 UTC -> closed
    expect(isWsMarketWindowOpen(true, new Date('2026-01-06T03:24:00Z'))).toBe(false);
    // 08:55 IST = 03:25 UTC -> open
    expect(isWsMarketWindowOpen(true, new Date('2026-01-06T03:25:00Z'))).toBe(true);
    // 18:00 IST = 12:30 UTC -> open (NSE closed, but MCX open)
    expect(isWsMarketWindowOpen(false, new Date('2026-01-06T12:30:00Z'))).toBe(false);
    expect(isWsMarketWindowOpen(true, new Date('2026-01-06T12:30:00Z'))).toBe(true);
    // 23:35 IST = 18:05 UTC -> open (cutoff boundary)
    expect(isWsMarketWindowOpen(true, new Date('2026-01-06T18:05:00Z'))).toBe(true);
    // 23:36 IST = 18:06 UTC -> closed
    expect(isWsMarketWindowOpen(true, new Date('2026-01-06T18:06:00Z'))).toBe(false);
  });

  it('keeps WebSocket closed on weekends and trading holidays', () => {
    // Weekend: Saturday 2026-01-10 10:00 IST = 04:30 UTC
    expect(isWsMarketWindowOpen(false, new Date('2026-01-10T04:30:00Z'))).toBe(false);
    expect(isWsMarketWindowOpen(true, new Date('2026-01-10T04:30:00Z'))).toBe(false);
    // Trading holiday: 2026-03-31 10:00 IST = 04:30 UTC
    expect(isWsMarketWindowOpen(false, new Date('2026-03-31T04:30:00Z'))).toBe(false);
    expect(isWsMarketWindowOpen(true, new Date('2026-03-31T04:30:00Z'))).toBe(false);
  });

  it('calculates ms until next WS market window accurately', () => {
    // Tuesday 08:00 IST -> opens today at 09:10 IST (70 mins = 4,200,000 ms)
    const ms = msUntilNextWsWindow(false, new Date('2026-01-06T02:30:00Z'));
    expect(ms).toBe(70 * 60 * 1000);

    // Tuesday 16:00 IST -> opens Wednesday at 09:10 IST (17h 10m = 61,800,000 ms)
    const msNextDay = msUntilNextWsWindow(false, new Date('2026-01-06T10:30:00Z'));
    expect(msNextDay).toBe(17 * 60 * 60 * 1000 + 10 * 60 * 1000);
  });

  it('returns window metadata via getWsMarketWindow', () => {
    const meta = getWsMarketWindow(false, new Date('2026-01-06T05:00:00Z'));
    expect(meta.isOpen).toBe(true);
    expect(meta.openTimeStr).toBe('09:10');
    expect(meta.closeTimeStr).toBe('15:35');
  });
});
