/**
 * lib/zoned-format.ts — Instants formatted for people, in an explicit zone.
 *
 * WHY: a formatter without a timeZone uses the runtime's zone. On the server
 * that is the host's (UTC on Vercel), so server-rendered pages printed UTC
 * dates and times while the schedule showed the viewer's. Server components
 * and server actions resolve the viewer's zone once per request
 * (getViewerTimeZone, lib/viewer-time-zone.ts) and format with it here, so
 * the same instant reads the same on every page as on the schedule.
 *
 * HYDRATION: a client component that first renders on the server takes that
 * zone as a prop and formats with it too, so the server's HTML and the
 * browser's first render produce the same string (no React #418/#425). The
 * locale is pinned to en-US (the app's copy language) for the same reason,
 * and the narrow no-break space some ICU versions put before AM/PM becomes a
 * plain space, so Node and every browser agree character for character.
 *
 * Calendar days ("YYYY-MM-DD": ?date=, due dates, expiry dates) are not
 * instants: handle them with lib/schedule-day.ts, never here.
 *
 * PURE: no DOM, no Next.js, no I/O. Unit tests: lib/__tests__/zoned-format.test.ts.
 */

/** An instant as the app carries it: ISO string, epoch ms, or Date. */
export type InstantInput = string | number | Date | null | undefined;

/** What a missing or unreadable instant shows. */
export const NO_TIME = '—';

/** "Nov 15, 2026" */
const DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
/** "Nov 15, 2026, 7:00 PM" */
const DATE_TIME: Intl.DateTimeFormatOptions = { ...DATE, hour: 'numeric', minute: '2-digit' };
/** "Nov 15, 7:00 PM" */
const SHORT_DATE_TIME: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};
/** "19:00" — the schedule's 24-hour clock. h23: midnight is 00:00, never 24:00. */
const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * An en-US formatter for `options` in `timeZone`. An unknown zone falls back
 * to UTC (callers pass a validated zone; this keeps a bad one from throwing).
 */
function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let fmt = formatters.get(key);
  if (!fmt) {
    // Zones come from a cookie: keep the cache bounded.
    if (formatters.size >= 256) formatters.clear();
    try {
      fmt = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
    } catch {
      fmt = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
    }
    formatters.set(key, fmt);
  }
  return fmt;
}

/** The instant `value` stands for, or null when absent or unreadable. */
function toDate(value: InstantInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** U+202F / U+00A0 → U+0020: ICU versions differ on the space before AM/PM. */
function plainSpaces(s: string): string {
  return s.replace(/[\u202f\u00a0]/g, ' ');
}

/**
 * formatInZone — `value` formatted with `options` (en-US) in `timeZone`;
 * NO_TIME when the value is absent or not a real instant. Never throws.
 */
export function formatInZone(
  value: InstantInput,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const d = toDate(value);
  if (!d) return NO_TIME;
  return plainSpaces(formatter(timeZone, options).format(d));
}

/** "Nov 15, 2026" — the calendar day of `value` in `timeZone`. */
export function formatZonedDate(value: InstantInput, timeZone: string): string {
  return formatInZone(value, timeZone, DATE);
}

/** "Nov 15, 2026, 7:00 PM" in `timeZone`. */
export function formatZonedDateTime(value: InstantInput, timeZone: string): string {
  return formatInZone(value, timeZone, DATE_TIME);
}

/** "Nov 15, 7:00 PM" in `timeZone` (no year: upcoming lists). */
export function formatZonedShortDateTime(value: InstantInput, timeZone: string): string {
  return formatInZone(value, timeZone, SHORT_DATE_TIME);
}

/** "19:00" in `timeZone` — the schedule's 24-hour clock. */
export function formatZonedClock(value: InstantInput, timeZone: string): string {
  return formatInZone(value, timeZone, CLOCK);
}

/**
 * zoneAbbreviation — the zone's short name at `at`, e.g. "CST" in winter and
 * "CDT" in summer for America/Chicago, "UTC" for UTC, or a GMT offset
 * ("GMT+5:30") where en-US has no abbreviation. Never throws.
 */
export function zoneAbbreviation(timeZone: string, at: Date = new Date()): string {
  const parts = formatter(timeZone, { timeZoneName: 'short' }).formatToParts(at);
  return plainSpaces(parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone);
}
