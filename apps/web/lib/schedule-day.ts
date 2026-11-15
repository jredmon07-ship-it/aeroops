/**
 * lib/schedule-day.ts — The schedule's ?date= day as a CALENDAR date.
 *
 * A "day" is a "YYYY-MM-DD" string: a date with no time and no zone, exactly
 * what ?date= carries. Parsing, stepping and labelling a day is calendar
 * arithmetic (UTC is only the carrier, as in month-grid.ts), so the server and
 * the browser always agree on which day it is.
 *
 * WHY: ?date= used to become a Date at the SERVER's local midnight (UTC on
 * Vercel) that the browser then formatted and stepped in ITS zone. West of UTC
 * that midnight is the evening before: ?date=2026-11-16 read "Sunday, November
 * 15", Next day linked back to 2026-11-16 (stuck), Previous day skipped to
 * 2026-11-14, and the board drew the day's blocks off its track.
 *
 * Only the reservations query needs a zone: a day runs from its first instant
 * to the next day's first instant in the VIEWER's zone (dayWindow). That is
 * the zone the app books and shows reservation times in — the browser's —
 * which the browser reports in the VIEWER_TZ_COOKIE cookie
 * (lib/viewer-time-zone.ts reads it). DST days are 23 or 25 hours long; a day
 * whose midnight a DST jump skips (Havana, Santiago, Beirut) starts at the jump.
 *
 * PURE: no DOM, no Next.js, no I/O. Unit tests: lib/__tests__/schedule-day.test.ts.
 */

const DAY_MS = 86_400_000;

/**
 * A calendar day. Five-digit years too: month-grid.ts pads the 9999-12 grid
 * into 10000-01 (and the 1970-01 grid back into 1969-12), and those cells
 * still need labels and query windows.
 */
const DAY_RE = /^(\d{4,5})-(\d{2})-(\d{2})$/;

/** The ?date= span: the same 1970–9999 years month-grid.ts accepts. */
const MIN_DAY_MS = Date.UTC(1970, 0, 1);
const MAX_DAY_MS = Date.UTC(9999, 11, 31);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DayParts {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
}

/** Half-open [from, to) instants — the shape listReservations takes. */
export interface DayWindow {
  from: Date;
  to: Date;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** The parts of UTC-carrier instant `ms` (UTC midnight of that calendar day). */
function partsFromUtcMs(ms: number): DayParts {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function formatDay(p: DayParts): string {
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** The parts of a real calendar day ("2026-02-30" is not one), or null. */
function partsOf(value: string): DayParts | null {
  const m = DAY_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  // Day 0 of the next month = the last day of this one.
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return { year, month, day };
}

// ─── ?date= param ─────────────────────────────────────────────────────────────

/**
 * parseDayParam — the "YYYY-MM-DD" ?date= value, or null when absent,
 * malformed, not a real date (2026-02-30) or outside 1970–9999. Never throws:
 * a bad URL degrades to the default day.
 */
export function parseDayParam(value: string | null | undefined): string | null {
  // A repeated ?date= reaches the page as an array — not a day.
  if (typeof value !== 'string' || value.length !== 10) return null;
  const p = partsOf(value);
  if (!p || p.year < 1970 || p.year > 9999) return null;
  return value;
}

/**
 * splitDay — the year / month / day of a "YYYY-MM-DD" calendar day.
 * @throws RangeError when `day` is not a real calendar day.
 */
export function splitDay(day: string): DayParts {
  const p = partsOf(day);
  if (!p) throw new RangeError(`schedule-day: not a YYYY-MM-DD day: ${day}`);
  return p;
}

/**
 * addDays — the day `delta` calendar days from `day` (may be negative). Rolls
 * months and years; DST cannot touch it. Clamps at the ?date= span
 * (1970-01-01 … 9999-12-31) instead of producing a day parseDayParam rejects,
 * so a nav button simply stops at the boundary.
 */
export function addDays(day: string, delta: number): string {
  if (!Number.isInteger(delta)) {
    throw new RangeError(`schedule-day: delta must be an integer: ${delta}`);
  }
  const p = splitDay(day);
  const ms = Date.UTC(p.year, p.month - 1, p.day + delta);
  if (Number.isNaN(ms)) return formatDay(partsFromUtcMs(delta < 0 ? MIN_DAY_MS : MAX_DAY_MS));
  return formatDay(partsFromUtcMs(Math.min(MAX_DAY_MS, Math.max(MIN_DAY_MS, ms))));
}

/**
 * dayLabel — human heading, e.g. "Monday, November 16, 2026". Formats the day
 * at UTC, so the label is the same on the server and in every browser zone.
 */
export function dayLabel(day: string, locale?: string): string {
  const p = splitDay(day);
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(p.year, p.month - 1, p.day)));
}

// ─── Time zones ───────────────────────────────────────────────────────────────

/** Cookie the browser reports its IANA time zone in (viewer-time-zone-sync.tsx). */
export const VIEWER_TZ_COOKIE = 'aeroops-tz';

/** IANA names are short ASCII paths ("America/Argentina/Buenos_Aires", "Etc/GMT+5"). */
const TZ_NAME_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;

/** isValidTimeZone — true iff `tz` is an IANA zone this runtime's Intl knows. */
export function isValidTimeZone(tz: string): boolean {
  if (!TZ_NAME_RE.test(tz)) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** resolveTimeZone — `value` when it is a valid zone (see isValidTimeZone), else `fallback`. */
export function resolveTimeZone(value: string | null | undefined, fallback: string): string {
  return typeof value === 'string' && isValidTimeZone(value) ? value : fallback;
}

interface ZonedParts extends DayParts {
  hour: number;
  minute: number;
  second: number;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = zonedFormatters.get(timeZone);
  if (!fmt) {
    // The zone comes from a cookie; keep the cache bounded.
    if (zonedFormatters.size >= 64) zonedFormatters.clear();
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    zonedFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/** The wall-clock fields of the instant `ms` in `timeZone`. */
function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24, // some engines print midnight as 24
    minute: get('minute'),
    second: get('second'),
  };
}

/** The zone's UTC offset at the instant `ms`, in ms (wall clock minus UTC). */
function offsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** dayInZone — the "YYYY-MM-DD" calendar day of `instant` in `timeZone`. */
export function dayInZone(instant: Date, timeZone: string): string {
  return formatDay(zonedParts(instant.getTime(), timeZone));
}

/**
 * startOfDayMs — the first instant of calendar day `p` in `timeZone`.
 *
 * Local midnight read as if it were UTC, minus the zone's offset. Near a DST
 * change that offset is one of two values, so try each offset in force from a
 * day before to a day after and keep the earliest instant that falls on the
 * day. A jump that skips midnight makes the day start at the jump, which is
 * exactly where the pre-jump offset puts midnight.
 */
function startOfDayMs(p: DayParts, timeZone: string): number {
  const wall = Date.UTC(p.year, p.month - 1, p.day);
  const target = formatDay(p);
  let start = Number.POSITIVE_INFINITY;
  for (const probe of [wall - DAY_MS, wall, wall + DAY_MS]) {
    const candidate = wall - offsetMs(probe, timeZone);
    if (candidate < start && dayInZone(new Date(candidate), timeZone) === target) {
      start = candidate;
    }
  }
  // A day the zone skipped outright (Samoa, 2011-12-30): an empty window at
  // the next day's start rather than an Invalid Date.
  return Number.isFinite(start) ? start : wall - offsetMs(wall, timeZone);
}

/**
 * dayWindow — the half-open [from, to) window of `day` in `timeZone`: its
 * first instant up to the next day's first instant (ADR-0004's half-open
 * convention, the shape listReservations takes).
 */
export function dayWindow(day: string, timeZone: string): DayWindow {
  const p = splitDay(day);
  const next = partsFromUtcMs(Date.UTC(p.year, p.month - 1, p.day + 1));
  return {
    from: new Date(startOfDayMs(p, timeZone)),
    to: new Date(startOfDayMs(next, timeZone)),
  };
}
