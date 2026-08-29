/**
 * NSE market-hours helpers. All comparisons use IST (UTC+5:30) regardless
 * of host timezone — the backend must behave identically on any server.
 *
 * Every function accepts an optional instant so callers (and tests) can
 * evaluate the clock at arbitrary times.
 */

export const IST_TZ = 'Asia/Kolkata';
export const IST_OFFSET_MINUTES = 330; // UTC+5:30

export interface MarketClock {
  istTime: string;          // HH:MM:SS IST
  istDate: string;          // YYYY-MM-DD IST
  dayOfWeek: number;        // 0=Sun … 6=Sat
  minutesOfDay: number;     // IST minutes since midnight
  isWeekday: boolean;
  isMarketOpen: boolean;    // regular session 09:15–15:30
  isPreOpen: boolean;       // 09:00–09:15
  isPostClose: boolean;     // after 15:30
  squareOffWindow: boolean; // 15:20–15:30 (auto square-off)
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
  const isMarketOpen = isWeekday && minutesOfDay >= 555 && minutesOfDay < 930;   // 09:15–15:30
  const isPreOpen = isWeekday && minutesOfDay >= 540 && minutesOfDay < 555;     // 09:00–09:15
  const isPostClose = isWeekday && minutesOfDay >= 930;
  const squareOffWindow = isWeekday && minutesOfDay >= 920 && minutesOfDay < 930; // 15:20–15:30
  const hh = String(hours).padStart(2, '0'), mm = String(minutes).padStart(2, '0'), ss = String(seconds).padStart(2, '0');
  return {
    istTime: `${hh}:${mm}:${ss}`,
    istDate: dateStr,
    dayOfWeek, minutesOfDay, isWeekday, isMarketOpen, isPreOpen, isPostClose, squareOffWindow,
  };
}

export function isIndianMarketOpen(now: Date = new Date()): boolean {
  return marketClock(now).isMarketOpen;
}
