/**
 * reporting/internal.ts — pure helpers for the reporting module.
 *
 * NOT exported from @aeroops/api. Contains:
 *
 * FROZEN (byte-identical for existing callers):
 *   - RangeKey ('7d'|'30d'|'90d')
 *   - resolveRange(range, now): { from: Date; to: Date }
 *     Rolling UTC window [now - Nd, now) (exclusive `to`).
 *
 * R1.1 ADDITIONS (additive only; resolveRange byte-unchanged):
 *   - ReportRangeKey ('7d'|'30d'|'90d'|'180d'|'365d')
 *   - BucketGranularity ('day'|'week')
 *   - resolveReportRange(key, now): { from: Date; to: Date }
 *   - chooseGranularity(key): BucketGranularity
 *   - bucketStartUtc(d, g): Date — UTC midnight (day) or UTC Monday 00:00 (week)
 *   - enumerateBuckets(from, to, g): Date[] — ordered zero-fill starts
 *   - safeAvg(num, den): number — 0 when den=0, 1dp
 *
 * All helpers are PURE (no I/O, no imports from external modules).
 * [VERIFY-R1-TZ] All bucketing is UTC — not localised to any tz.
 */

// ─── Frozen range key (existing callers — byte-identical) ────────────────────

export type RangeKey = '7d' | '30d' | '90d';

// ─── R1.1: Widened range key ──────────────────────────────────────────────────

/**
 * ReportRangeKey — the full set of range keys accepted by R1.1 report reads.
 * Superset of RangeKey (which only had '7d'|'30d'|'90d').
 * Enum admits exactly 5 values → buckets ≤ ~53 (week-granularity 365d).
 */
export type ReportRangeKey = '7d' | '30d' | '90d' | '180d' | '365d';

// ─── R1.1: Bucket granularity ─────────────────────────────────────────────────

/**
 * BucketGranularity — the time unit for trend bucket rows.
 *   'day'  → UTC midnight-to-midnight (≤ 30 rows for 7d/30d)
 *   'week' → UTC Monday 00:00–Sunday 23:59:59 (≤ ~53 rows for 90d/180d/365d)
 */
export type BucketGranularity = 'day' | 'week';

// ─── Frozen resolveRange ──────────────────────────────────────────────────────

/**
 * resolveRange — converts a range key into an absolute UTC window.
 *
 * Rolling window: [now - N days, now) — `to` is exclusive (half-open).
 * Both bounds are computed in UTC; no tz conversion is performed.
 *
 * FROZEN: behavior byte-identical for existing callers (7d/30d/90d).
 *
 * @param range - '7d' | '30d' | '90d'
 * @param now   - Injected current time (enables deterministic unit tests).
 * @returns     - { from: Date, to: Date } where to === now (exclusive upper).
 */
export function resolveRange(
  range: RangeKey,
  now: Date,
): { from: Date; to: Date } {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;

  const to = new Date(now.getTime()); // copy, exclusive upper bound = now
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  return { from, to };
}

// ─── R1.1: resolveReportRange ─────────────────────────────────────────────────

/**
 * resolveReportRange — converts a ReportRangeKey into an absolute UTC window.
 *
 * Rolling window: [now - N days, now) — `to` is exclusive (half-open).
 * Supports the widened R1.1 set: 7d/30d/90d/180d/365d.
 * All arithmetic in UTC milliseconds; no tz conversion performed.
 *
 * Numerator/denominator for hand-verification:
 *   from = now.getTime() - N * 86_400_000 ms
 *   to   = now.getTime()   (exclusive)
 *
 * [VERIFY-R1-TZ]: UTC window; display layer is responsible for localisation.
 *
 * @param key - ReportRangeKey ('7d'|'30d'|'90d'|'180d'|'365d')
 * @param now - Injected current time (deterministic unit tests).
 * @returns   { from: Date, to: Date } where `to` equals `now` (exclusive).
 */
export function resolveReportRange(
  key: ReportRangeKey,
  now: Date,
): { from: Date; to: Date } {
  const DAYS: Record<ReportRangeKey, number> = {
    '7d':   7,
    '30d':  30,
    '90d':  90,
    '180d': 180,
    '365d': 365,
  };
  const days = DAYS[key];
  const to   = new Date(now.getTime());
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { from, to };
}

// ─── R1.1: chooseGranularity ──────────────────────────────────────────────────

/**
 * chooseGranularity — maps a ReportRangeKey to the appropriate BucketGranularity.
 *
 * Rule (bounds buckets ≤ ~53):
 *   '7d'  → 'day'  (7 buckets)
 *   '30d' → 'day'  (30 buckets)
 *   '90d' → 'week' (~13 buckets)
 *   '180d'→ 'week' (~26 buckets)
 *   '365d'→ 'week' (~53 buckets)
 */
export function chooseGranularity(key: ReportRangeKey): BucketGranularity {
  return key === '7d' || key === '30d' ? 'day' : 'week';
}

// ─── R1.1: bucketStartUtc ─────────────────────────────────────────────────────

/**
 * bucketStartUtc — floors a Date to the start of its UTC bucket.
 *
 * For 'day':  floor to UTC midnight (00:00:00.000 UTC on the same calendar day).
 * For 'week': floor to the immediately preceding (or same) Monday at UTC 00:00.
 *             ISO 8601: week starts Monday (getUTCDay() === 1).
 *             Sunday (0) is treated as day +6 past the prior Monday.
 *
 * ALL arithmetic is in UTC — wall-clock DST transitions cannot affect it.
 * [VERIFY-R1-TZ]: UTC-stable; no localisation.
 *
 * @param d - Any Date (may be mid-bucket).
 * @param g - 'day' | 'week'
 * @returns   New Date floored to bucket start (UTC).
 */
export function bucketStartUtc(d: Date, g: BucketGranularity): Date {
  if (g === 'day') {
    // Floor to UTC midnight on the same calendar day.
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  // Week: floor to the Monday 00:00 UTC that starts the week containing d.
  // getUTCDay(): 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
  const dayOfWeek = d.getUTCDay(); // 0..6
  // Days to subtract to reach Monday: Mon→0, Tue→1, …, Sun→6
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysToMonday));
}

// ─── R1.1: enumerateBuckets ───────────────────────────────────────────────────

/**
 * enumerateBuckets — produces an ordered array of bucket-start Dates for zero-fill.
 *
 * Iterates from the bucket containing `from` (inclusive) up to but not including
 * the bucket that starts AT or AFTER `to`.  Every bucket returned is a UTC-aligned
 * Date produced by bucketStartUtc.
 *
 * Purpose: zero-fill in memory so every bucket in [from, to) appears in the result
 * even when the DB returns no rows for that bucket.
 *
 * Bounded: ≤ 7 (7d/day), ≤ 30 (30d/day), ≤ ~53 (365d/week).
 *
 * @param from - Rolling window lower bound (inclusive).
 * @param to   - Rolling window upper bound (exclusive).
 * @param g    - Granularity.
 * @returns    Ordered array of bucket-start Dates (UTC).
 */
export function enumerateBuckets(from: Date, to: Date, g: BucketGranularity): Date[] {
  const MS_PER_DAY  = 24 * 60 * 60 * 1000;
  const step = g === 'day' ? MS_PER_DAY : 7 * MS_PER_DAY;

  const buckets: Date[] = [];
  let cursor = bucketStartUtc(from, g);

  // Safety cap: never emit more than 400 buckets (defensive; spec says ≤~53).
  let guard = 0;
  while (cursor < to && guard < 400) {
    buckets.push(cursor);
    cursor = new Date(cursor.getTime() + step);
    guard++;
  }
  return buckets;
}

// ─── R1.1: safeAvg ───────────────────────────────────────────────────────────

/**
 * safeAvg — division-by-zero-safe average, rounded to 1dp.
 *
 * Metric definition:
 *   numerator   = sum of the values (e.g. totalFlightHours)
 *   denominator = count of items   (e.g. totalFlights)
 *   result      = 0 when denominator = 0 (no div-by-zero, no NaN/Infinity)
 *                 Math.round(numerator / denominator * 10) / 10 otherwise (1dp)
 *
 * @param num - Numerator (e.g. total hours).
 * @param den - Denominator (e.g. flight count). 0 → result is 0.
 * @returns   Rounded-to-1dp average, or 0 when den=0.
 */
export function safeAvg(num: number, den: number): number {
  if (den === 0) return 0;
  return Math.round((num / den) * 10) / 10;
}
