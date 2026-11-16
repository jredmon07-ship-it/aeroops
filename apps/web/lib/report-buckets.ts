/**
 * lib/report-buckets.ts — the calendar day a report bucket covers.
 *
 * The reporting reads bucket in the zone the actions pass them (the viewer's,
 * from getViewerTimeZone) and echo it back as range.timeZone. Each bucket's
 * start is an instant: the first instant of a local day, or of a local Monday
 * for week buckets. Labels, sparklines and CSV rows need that DAY, not the
 * instant's UTC date: Chicago's Nov 15 starts 2026-11-15T06:00Z, but Berlin's
 * starts 2026-11-14T23:00Z. [VERIFY-R1-TZ]
 *
 * PURE: no I/O, no Next.js. Unit tests: lib/__tests__/report-buckets.test.ts.
 */

import { dayInZone } from './schedule-day';

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * bucketDay — the "YYYY-MM-DD" day a bucket starting at `bucketStartIso`
 * covers, read in `timeZone`: the zone the read bucketed in (its echoed
 * range.timeZone), or UTC when it echoed none (the rolling UTC default).
 * Never throws: an unreadable instant or zone gives the ISO string's first
 * ten characters (its UTC date).
 */
export function bucketDay(bucketStartIso: string, timeZone: string | undefined): string {
  const at = new Date(bucketStartIso);
  if (!Number.isNaN(at.getTime())) {
    try {
      return dayInZone(at, timeZone ?? 'UTC');
    } catch {
      // A zone this runtime's Intl does not know: the UTC date below.
    }
  }
  return bucketStartIso.slice(0, 10);
}

/**
 * formatBucketDayShort — the dashboard chart's axis label for a bucket day:
 * "11/15" (month/day, no padding). '' when `day` is not "YYYY-MM-DD".
 */
export function formatBucketDayShort(day: string): string {
  const m = DAY_RE.exec(day);
  if (!m) return '';
  return `${Number(m[2])}/${Number(m[3])}`;
}
