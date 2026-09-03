/**
 * NSE/BSE equity & derivatives segment trading holidays.
 *
 * Without this, marketClock() reads a trading holiday as a normal open
 * weekday: the stale-tick breaker screams all day (no ticks will ever
 * arrive), the autonomous scanner busy-loops trying to trade a closed
 * market, and nearestIndexExpiry() can compute an expiry date that never
 * actually trades.
 *
 * Sourced from NSE/BSE holiday calendars (cross-checked across two
 * independent publishers on 2026-09-03) — not derived or guessed. Extend
 * this list at each calendar year-end; there is no algorithmic way to
 * derive Indian market holidays (they mix fixed dates, lunar-calendar
 * festivals, and ad-hoc regional closures).
 *
 * Muhurat trading (a special ~1hr evening session on a Diwali Sunday,
 * 2026-11-08) is NOT modelled — it doesn't fit the regular 09:15–15:30
 * session shape this system assumes, and this system has no positions
 * open on a day it would already consider a weekend.
 */
export const NSE_BSE_HOLIDAYS_2026: ReadonlySet<string> = new Set([
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-26', // Shri Ram Navami
  '2026-03-31', // Shri Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Bakri Id
  '2026-06-26', // Muharram
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-10', // Diwali-Balipratipada
  '2026-11-24', // Prakash Gurpurb Sri Guru Nanak Dev
  '2026-12-25', // Christmas
]);

const ALL_HOLIDAYS: ReadonlySet<string> = NSE_BSE_HOLIDAYS_2026;

/** dateStr is an IST calendar date (YYYY-MM-DD, as produced by istParts()). */
export function isTradingHoliday(dateStr: string): boolean {
  return ALL_HOLIDAYS.has(dateStr);
}

const YEAR_COVERAGE = new Set([...ALL_HOLIDAYS].map((d) => d.slice(0, 4)));

/** True once we've walked off the end of the calendar this module actually
 * knows about — callers use this to raise a loud warning rather than
 * silently treating every day of an uncovered year as tradeable. */
export function hasHolidayCoverage(dateStr: string): boolean {
  return YEAR_COVERAGE.has(dateStr.slice(0, 4));
}
