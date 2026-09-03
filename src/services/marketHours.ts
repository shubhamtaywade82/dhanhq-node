/**
 * NSE market-hours helpers. All comparisons use IST (UTC+5:30) regardless
 * of host timezone — the backend must behave identically on any server.
 *
 * Every function accepts an optional instant so callers (and tests) can
 * evaluate the clock at arbitrary times.
 */
import { isTradingHoliday } from './holidays';

export const IST_TZ = 'Asia/Kolkata';
export const IST_OFFSET_MINUTES = 330; // UTC+5:30

export interface MarketClock {
  istTime: string;          // HH:MM:SS IST
  istDate: string;          // YYYY-MM-DD IST
  dayOfWeek: number;        // 0=Sun … 6=Sat
  minutesOfDay: number;     // IST minutes since midnight
  isWeekday: boolean;       // Mon-Fri, holiday-blind (calendar fact only)
  isTradingHoliday: boolean;
  isTradingDay: boolean;    // isWeekday && !isTradingHoliday — what "open" actually depends on
  isMarketOpen: boolean;    // regular session 09:15–15:30 on a trading day
  isPreOpen: boolean;       // 09:00–09:15 on a trading day
  isPostClose: boolean;     // after 15:30 on a trading day
  squareOffWindow: boolean; // 15:20–15:30 (auto square-off) on a trading day
}

/** 15:30 IST — market close / expiry settlement cutoff. Comparing hours and
 * minutes separately (the bug this replaces) is wrong at any time past
 * 15:30 with minutes < 30 on the next check, e.g. 16:05 evaluated as
 * hours>=15 && minutes>=30 is false — "not yet past cutoff" hours after it
 * clearly was. */
export function isPastExpiryCutoff(hours: number, minutes: number): boolean {
  return hours > 15 || (hours === 15 && minutes >= 30);
}

/** Convert any instant into IST-shifted wall-clock components. */
export function istParts(now: Date = new Date()): { hours: number; minutes: number; seconds: number; dayOfWeek: number; dateStr: string } {
  const utcMs = now.getTime();
  const istMs = utcMs + IST_OFFSET_MINUTES * 60_000;
  const d = new Date(istMs);
  return {
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
    dayOfWeek: d.getUTCDay(),
    dateStr: d.toISOString().slice(0, 10),
  };
}

export function istNow(now: Date = new Date()): Date {
  // A Date whose LOCAL wall-clock equals IST wall-clock (for display paths).
  const { hours, minutes, seconds } = istParts(now);
  const d = new Date();
  d.setHours(hours, minutes, seconds, 0);
  return d;
}

export function marketClock(now: Date = new Date()): MarketClock {
  const { hours, minutes, seconds, dayOfWeek, dateStr } = istParts(now);
  const minutesOfDay = hours * 60 + minutes;
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const holiday = isTradingHoliday(dateStr);
  const isTradingDay = isWeekday && !holiday;
  const isMarketOpen = isTradingDay && minutesOfDay >= 555 && minutesOfDay < 930;   // 09:15–15:30
  const isPreOpen = isTradingDay && minutesOfDay >= 540 && minutesOfDay < 555;     // 09:00–09:15
  const isPostClose = isTradingDay && minutesOfDay >= 930;
  const squareOffWindow = isTradingDay && minutesOfDay >= 920 && minutesOfDay < 930; // 15:20–15:30
  const hh = String(hours).padStart(2, '0'), mm = String(minutes).padStart(2, '0'), ss = String(seconds).padStart(2, '0');
  return {
    istTime: `${hh}:${mm}:${ss}`,
    istDate: dateStr,
    dayOfWeek, minutesOfDay, isWeekday, isTradingHoliday: holiday, isTradingDay,
    isMarketOpen, isPreOpen, isPostClose, squareOffWindow,
  };
}

export function isIndianMarketOpen(now: Date = new Date()): boolean {
  return marketClock(now).isMarketOpen;
}

/** Exchanges prepone expiry to the previous trading day when the calculated
 * expiry date is itself a trading holiday (Diwali-Balipratipada, etc.) —
 * without this, a computed expiry can be a date the market never opens on. */
function rollBackToTradingDay(dateStr: string): string {
  let d = new Date(`${dateStr}T00:00:00Z`);
  for (let i = 0; i < 10; i++) {
    const dow = d.getUTCDay();
    const ds = d.toISOString().slice(0, 10);
    if (dow >= 1 && dow <= 5 && !isTradingHoliday(ds)) return ds;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dateStr; // defensive: should be unreachable with a sane holiday list
}

/**
 * Computes nearest valid expiry for Indian indices per SEBI 2025-2026 schedule:
 * - NIFTY: Weekly on Tuesday (2)
 * - SENSEX: Weekly on Thursday (4)
 * - BANKNIFTY: Monthly on last Tuesday of the month
 *
 * The weekday/month-end arithmetic below picks the calendar date the
 * schedule names; rollBackToTradingDay() then corrects it to the actual
 * trading day when that calendar date is a holiday. This is a fallback —
 * prefer resolveNearestExpiry() (marketData.ts), which reads the real
 * expiry list off the live option chain and only falls back to this
 * weekday guess when that call fails.
 */
export function nearestIndexExpiry(symbol = 'NIFTY', now: Date = new Date()): string {
  const sym = symbol.toUpperCase();
  const parts = istParts(now);
  const targetDay = sym === 'SENSEX' ? 4 : 2; // Thursday for SENSEX, Tuesday for NIFTY/BANKNIFTY

  if (sym === 'BANKNIFTY') {
    return rollBackToTradingDay(getLastTuesdayOfMonth(parts.dateStr, isPastExpiryCutoff(parts.hours, parts.minutes)));
  }

  let delta = (targetDay - parts.dayOfWeek + 7) % 7;
  if (delta === 0 && isPastExpiryCutoff(parts.hours, parts.minutes)) delta = 7;
  const d = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  d.setUTCDate(d.getUTCDate() + delta);
  return rollBackToTradingDay(d.toISOString().slice(0, 10));
}

function getLastTuesdayOfMonth(dateStr: string, passedExpiryHour: boolean): string {
  const [y, m] = dateStr.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0));
  const day = lastDay.getUTCDay();
  const diff = (day - 2 + 7) % 7;
  lastDay.setUTCDate(lastDay.getUTCDate() - diff);
  const expiryStr = lastDay.toISOString().slice(0, 10);

  if (dateStr > expiryStr || (dateStr === expiryStr && passedExpiryHour)) {
    const nextMonthLastDay = new Date(Date.UTC(y, m + 1, 0));
    const nextDiff = (nextMonthLastDay.getUTCDay() - 2 + 7) % 7;
    nextMonthLastDay.setUTCDate(nextMonthLastDay.getUTCDate() - nextDiff);
    return nextMonthLastDay.toISOString().slice(0, 10);
  }
  return expiryStr;
}

