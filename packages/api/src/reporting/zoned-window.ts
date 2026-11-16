/**
 * reporting/zoned-window.ts — report windows and buckets in the viewer's time
 * zone (R1-TZ). Pure: Intl only, no I/O. NOT exported from @aeroops/api.
 *
 * WHY: the reporting reads cut "last N days" as a rolling UTC window and
 * bucketed by UTC day ([VERIFY-R1-TZ], R1.1). The hosted demo's server runs
 * on UTC and its viewers are in America/Chicago, so a flight closed at
 * 20:00 CST counted on the next day and "last 30 days" began at a UTC
 * midnight. A read given the viewer's `timeZone` works in that zone's
 * calendar instead:
 *
 *   window   the N calendar days ending on the day of the window's last
 *            instant: [first instant of (lastDay − (N − 1)), now). Today is
 *            day N, so a 30-day chart by day always has exactly 30 buckets.
 *   buckets  calendar days, ISO weeks (Monday first) or months of the zone,
 *            each starting at the first instant of its first day. A DST day
 *            is 23 or 25 hours long: stepping is calendar arithmetic, never
 *            "+ 24 h".
 *   zone     isValidIanaTz, else UTC: an unknown zone reads as UTC.
 *
 * Without `timeZone` a read keeps its original rolling UTC window and UTC
 * buckets (resolveReportRange / resolveRange / enumerateBuckets), so existing
 * callers get byte-identical results.
 *
 * Rows are bucketed in SQL against these instants (width_bucket over the
 * bucket starts, see timestamptzArrayLiteral), not with `AT TIME ZONE`, so
 * the database never interprets the zone. Three measured reasons:
 *   - Node's ICU and Postgres's tzdata disagree on some zones: America/Vancouver
 *     after 2026-11-01 is an hour apart (Node 24 vs PGlite 0.5.2 / PG 18.3),
 *     which would move rows near midnight to the wrong day and drop the ones
 *     just after the window's start.
 *   - Postgres resolves an ambiguous local midnight to the LATER instant
 *     (America/Havana repeats 00:00–00:59 on 2026-11-01), while the day starts
 *     at the first one, so a converted-back bucket start would match nothing.
 *   - Postgres reads '+05' as POSIX (UTC−5); Intl reads it as UTC+5.
 * One clock, the server's ICU (the same one that labels the buckets on the
 * web), decides which day every row falls on.
 *
 * The day math mirrors apps/web/lib/schedule-day.ts (dayInZone, dayWindow),
 * so a bucket starts exactly where the web's day window for that day does.
 */

import { isValidIanaTz } from '../scheduling/internal.js';
import { enumerateBuckets } from './internal.js';
import type { BucketGranularity, ReportRangeKey } from './internal.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * CalendarUnit — what one zoned bucket spans. The reads bucket by day or week
 * (chooseGranularity); 'month' is supported here for a longer range.
 */
export type CalendarUnit = BucketGranularity | 'month';

/** A half-open [from, to) report window and the zone it was cut in. */
export interface ReportWindow {
  /** Inclusive lower bound. */
  from: Date;
  /** Exclusive upper bound: the request time. */
  to: Date;
  /**
   * The zone the window and its buckets are in, after the UTC fallback.
   * null: the caller passed no timeZone, so this is the original rolling UTC
   * window [now − N days, now).
   */
  timeZone: string | null;
}

/** One zoned bucket of the zero-fill list. */
export interface ZonedBucket {
  /** The bucket's first calendar day in the zone, "YYYY-MM-DD". */
  day: string;
  /** The first instant of that day in the zone. */
  start: Date;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Days in each range key's window (RangeKey's 7d/30d/90d are a subset). */
const RANGE_DAYS: Record<ReportRangeKey, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '180d': 180,
  '365d': 365,
};

/** Zero-fill cap, as enumerateBuckets (a 365-day window spans ≤ 53 weeks). */
const MAX_BUCKETS = 400;

// ─── Zone ─────────────────────────────────────────────────────────────────────

/**
 * resolveReportTimeZone — `timeZone` when Intl accepts it (isValidIanaTz),
 * else 'UTC'. A report never fails over an unknown zone; it reads as UTC.
 */
export function resolveReportTimeZone(timeZone: string): string {
  return isValidIanaTz(timeZone) ? timeZone : 'UTC';
}

// ─── Calendar days ("YYYY-MM-DD", UTC as the carrier) ─────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** The calendar day of the UTC-carrier instant `ms`. */
function carrierDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** The UTC-carrier instant (UTC midnight) of calendar day `day`. */
function carrierMs(day: string): number {
  const [y = Number.NaN, m = Number.NaN, d = Number.NaN] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** The calendar day `delta` days from `day` (may be negative). DST cannot touch it. */
export function addCalendarDays(day: string, delta: number): string {
  return carrierDay(carrierMs(day) + delta * DAY_MS);
}

/**
 * floorCalendarDay — the first day of the bucket `day` falls in: the day
 * itself, the Monday of its ISO week, or the 1st of its month.
 */
export function floorCalendarDay(day: string, unit: CalendarUnit): string {
  if (unit === 'day') return day;
  const ms = carrierMs(day);
  const d = new Date(ms);
  if (unit === 'week') {
    // getUTCDay(): 0 = Sunday … 6 = Saturday. Monday → 0 days back, Sunday → 6.
    return carrierDay(ms - ((d.getUTCDay() + 6) % 7) * DAY_MS);
  }
  return carrierDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** The first day of the bucket after the one starting on `day`. */
function nextBucketDay(day: string, unit: CalendarUnit): string {
  const d = new Date(carrierMs(day));
  if (unit === 'month') return carrierDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const step = unit === 'week' ? 7 : 1;
  return carrierDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + step));
}

// ─── Wall clock in a zone ─────────────────────────────────────────────────────

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = wallFormatters.get(timeZone);
  if (!fmt) {
    // The zone comes from the viewer's cookie: keep the cache bounded.
    if (wallFormatters.size >= 64) wallFormatters.clear();
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
    wallFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/** The wall-clock fields of the instant `ms` in `timeZone`. */
function wallClock(ms: number, timeZone: string): WallClock {
  const parts = wallFormatter(timeZone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
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
  const w = wallClock(ms, timeZone);
  const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** zonedCalendarDay — the "YYYY-MM-DD" calendar day `instant` falls on in `timeZone`. */
export function zonedCalendarDay(instant: Date, timeZone: string): string {
  const w = wallClock(instant.getTime(), timeZone);
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
}

/**
 * startOfZonedDay — the first instant of calendar day `day` in `timeZone`.
 *
 * Local midnight read as UTC, minus the zone's offset. Near a DST change that
 * offset is one of two values, so each offset in force from a day before to a
 * day after is tried and the earliest instant that falls on `day` wins: a
 * fall-back that repeats midnight (America/Havana) starts the day at the
 * first midnight, and a jump that skips midnight (Asia/Beirut) starts it at
 * the jump. Same algorithm as apps/web/lib/schedule-day.ts startOfDayMs.
 */
export function startOfZonedDay(day: string, timeZone: string): Date {
  const wall = carrierMs(day);
  let start = Number.POSITIVE_INFINITY;
  for (const probe of [wall - DAY_MS, wall, wall + DAY_MS]) {
    const candidate = wall - offsetMs(probe, timeZone);
    if (candidate < start && zonedCalendarDay(new Date(candidate), timeZone) === day) {
      start = candidate;
    }
  }
  // A day the zone skipped outright (Pacific/Apia, 2011-12-30): an empty
  // bucket at the next day's start rather than an Invalid Date.
  return new Date(Number.isFinite(start) ? start : wall - offsetMs(wall, timeZone));
}

// ─── Windows ──────────────────────────────────────────────────────────────────

/**
 * resolveZonedReportRange — "last N days" as N calendar days in `timeZone`.
 *
 *   lastDay = the zone's day of the window's last instant (now − 1 ms): today,
 *             or yesterday when now is exactly local midnight (today is empty)
 *   from    = the first instant of lastDay − (N − 1), i.e. a local midnight
 *   to      = now (exclusive, as the rolling window)
 *
 * An unknown zone reads as UTC (the returned timeZone says which was used).
 */
export function resolveZonedReportRange(
  key: ReportRangeKey,
  now: Date,
  timeZone: string,
): { from: Date; to: Date; timeZone: string } {
  const zone = resolveReportTimeZone(timeZone);
  const lastDay = zonedCalendarDay(new Date(now.getTime() - 1), zone);
  const firstDay = addCalendarDays(lastDay, -(RANGE_DAYS[key] - 1));
  return {
    from: startOfZonedDay(firstDay, zone),
    to: new Date(now.getTime()),
    timeZone: zone,
  };
}

/**
 * zonedReportWindow — the window a read covers: the original rolling UTC one
 * (`legacy`, e.g. resolveReportRange) when the caller passed no timeZone,
 * else the zone's last N calendar days (resolveZonedReportRange).
 */
export function zonedReportWindow<K extends ReportRangeKey>(
  key: K,
  now: Date,
  timeZone: string | undefined,
  legacy: (key: K, now: Date) => { from: Date; to: Date },
): ReportWindow {
  if (timeZone === undefined) return { ...legacy(key, now), timeZone: null };
  return resolveZonedReportRange(key, now, timeZone);
}

/**
 * reportRangeHeader — the `range` a read returns. The zone is echoed only when
 * the caller passed one, so the default output keeps its exact shape.
 */
export function reportRangeHeader<K extends string>(
  key: K,
  { from, to, timeZone }: ReportWindow,
): { key: K; from: Date; to: Date; timeZone?: string } {
  return timeZone === null ? { key, from, to } : { key, from, to, timeZone };
}

// ─── Buckets ──────────────────────────────────────────────────────────────────

/**
 * enumerateZonedBuckets — the zero-fill list for [from, to) in `timeZone`:
 * every calendar day / ISO week / month from the one holding `from` to the
 * one holding the window's last instant (to − 1 ms), in order. Each starts at
 * the first instant of its first day, so a 25-hour fall-back day is one
 * bucket, not one and a bit. An empty window has no buckets.
 */
export function enumerateZonedBuckets(
  from: Date,
  to: Date,
  unit: CalendarUnit,
  timeZone: string,
): ZonedBucket[] {
  if (to.getTime() <= from.getTime()) return [];
  const zone = resolveReportTimeZone(timeZone);
  const lastDay = floorCalendarDay(zonedCalendarDay(new Date(to.getTime() - 1), zone), unit);
  const buckets: ZonedBucket[] = [];
  let day = floorCalendarDay(zonedCalendarDay(from, zone), unit);
  while (day <= lastDay && buckets.length < MAX_BUCKETS) {
    buckets.push({ day, start: startOfZonedDay(day, zone) });
    day = nextBucketDay(day, unit);
  }
  return buckets;
}

/**
 * reportBucketStarts — the zero-fill bucket starts of a report window: UTC
 * midnights / UTC Mondays (enumerateBuckets, the original grain) when it has
 * no zone, else the zone's days or weeks (enumerateZonedBuckets).
 */
export function reportBucketStarts(
  { from, to, timeZone }: ReportWindow,
  granularity: BucketGranularity,
): Date[] {
  if (timeZone === null) return enumerateBuckets(from, to, granularity);
  return enumerateZonedBuckets(from, to, granularity, timeZone).map((b) => b.start);
}

/**
 * timestamptzArrayLiteral — bucket starts as a Postgres array literal, bound
 * as ONE string parameter and cast: width_bucket(ts, $1::timestamptz[]) is
 * then the 1-based bucket with starts[i] ≤ ts < starts[i + 1]. ISO instants
 * hold no comma, brace or quote. (A string because the postgres-js
 * production driver cannot serialize a JS Date.)
 */
export function timestamptzArrayLiteral(starts: readonly Date[]): string {
  return `{${starts.map((d) => d.toISOString()).join(',')}}`;
}
