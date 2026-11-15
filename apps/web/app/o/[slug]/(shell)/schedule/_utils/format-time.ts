/**
 * _utils/format-time.ts — Clock-time formatting for the schedule module.
 *
 * Every clock time the schedule shows is "HH:mm", 24 h (spec §3), read on the
 * wall clock of an EXPLICIT IANA zone: the viewer's, which the page resolves
 * per request (lib/viewer-time-zone.ts) and hands down as `timeZone`.
 *
 * WHY: these helpers used to format in the runtime's own zone. The server
 * renders in UTC on Vercel and the browser in the viewer's zone, so the HTML
 * said "14:00 – 15:00" where the browser said "08:00 – 09:00": React threw
 * the server HTML away (error #418, "Hydration failed") and cards, board
 * blocks and month chips showed UTC times until it re-rendered them.
 *
 * The locale is pinned as well ("en-US" with a 00–23 hour cycle): "HH:mm" is
 * the spec's format, and a browser locale such as fi-FI ("08.00") or ar-EG
 * (Arabic-Indic digits) would not match the server's text either.
 *
 * Interactions (the date and time a user types to create or move a
 * reservation) are still read in the browser's zone — toDateInputValue below.
 * The page's zone is the browser's once ViewerTimeZoneSync has reported it.
 *
 * The ?date= day itself is a calendar date, not a Date: parse, step, label it
 * and build its query window with lib/schedule-day.ts.
 */

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

/**
 * A cached "HH:mm" formatter for `timeZone`. Callers pass a validated zone; a
 * zone this runtime's Intl does not know (a series zone an old browser lacks)
 * reads UTC instead of throwing, as lib/zoned-format.ts does.
 */
function clockFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = clockFormatters.get(timeZone);
  if (!fmt) {
    // Zones come from a cookie or a series row; keep the cache bounded.
    if (clockFormatters.size >= 64) clockFormatters.clear();
    try {
      fmt = new Intl.DateTimeFormat('en-US', { ...CLOCK, timeZone });
    } catch {
      fmt = new Intl.DateTimeFormat('en-US', { ...CLOCK, timeZone: 'UTC' });
    }
    clockFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * formatTimeRange — a start+end pair as "HH:mm – HH:mm" on `timeZone`'s clock.
 *
 * @param start    - The start of the window.
 * @param end      - The end of the window.
 * @param timeZone - IANA zone to read the clock in (the viewer's).
 * @returns        - e.g. "09:30 – 11:00"
 */
export function formatTimeRange(start: Date, end: Date, timeZone: string): string {
  const fmt = clockFormatter(timeZone);
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

/**
 * formatTime — one instant as "HH:mm" on `timeZone`'s clock.
 */
export function formatTime(date: Date, timeZone: string): string {
  return clockFormatter(timeZone).format(date);
}

/**
 * toDateInputValue — formats a Date as "YYYY-MM-DD" for <input type="date">:
 * its calendar day in the runtime's local zone (the browser's, client side).
 * For interactions only; a day rendered on the server is
 * dayInZone(date, timeZone) from lib/schedule-day.ts.
 */
export function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
