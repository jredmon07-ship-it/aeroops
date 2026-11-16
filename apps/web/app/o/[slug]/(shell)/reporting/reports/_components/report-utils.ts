/**
 * report-utils.ts — Pure display helpers for Slice R1.2 Operational Reports.
 *
 * NO I/O, NO Next.js imports. Safe to use in RSC and tests.
 *
 * [VERIFY-R1-TZ]: the trend buckets arrive bucketed in the viewer's zone, each
 * with the calendar `day` it covers ("YYYY-MM-DD", lib/report-buckets.ts).
 * The labels here print that day as-is — the zone was applied server-side.
 */

// ─── Report range key ──────────────────────────────────────────────────────────

export type ReportRangeKey = '7d' | '30d' | '90d' | '180d' | '365d';

/**
 * resolveReportRangeKey — validates a raw ?range= string and falls back to '30d'.
 * Accepts the 5 R1 range keys; anything else → '30d'.
 */
export function resolveReportRangeKey(
  raw: string | string[] | undefined | null,
): ReportRangeKey {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (
    v === '7d' ||
    v === '30d' ||
    v === '90d' ||
    v === '180d' ||
    v === '365d'
  ) {
    return v;
  }
  return '30d';
}

/**
 * reportRangeLabelFull — human-readable label for a ReportRangeKey.
 * Used in section headings: "Last 30 days".
 */
export function reportRangeLabelFull(key: ReportRangeKey): string {
  const LABELS: Record<ReportRangeKey, string> = {
    '7d':   '7 days',
    '30d':  '30 days',
    '90d':  '90 days',
    '180d': '180 days',
    '365d': '365 days',
  };
  return LABELS[key];
}

// ─── Bucket label ──────────────────────────────────────────────────────────────

/**
 * formatBucketLabel — a bucket's calendar day as a short label.
 *
 * For 'day' granularity: "MMM D"  (e.g. "Jun 5")
 * For 'week' granularity: "MMM D–" (e.g. "Jun 2–") indicating week start.
 *
 * `bucketDay` is the bucket's `day` ("YYYY-MM-DD", already the viewer's
 * calendar day); an ISO instant also works and reads as its UTC date. The
 * date is printed as given — never shifted by the server's zone.
 * Returns '—' on parse failure (never throws).
 *
 * [VERIFY-R1-TZ]: the zone is applied where the bucket's day is computed.
 */
export function formatBucketLabel(
  bucketDay: string,
  granularity: string,
): string {
  try {
    // A date-only "YYYY-MM-DD" parses as UTC midnight, so getUTC* is that day.
    const d = new Date(bucketDay);
    if (isNaN(d.getTime())) return '—';

    const MONTHS = [
      'Jan','Feb','Mar','Apr','May','Jun',
      'Jul','Aug','Sep','Oct','Nov','Dec',
    ];
    const month = MONTHS[d.getUTCMonth()];
    const day = d.getUTCDate();

    if (!month) return '—';

    if (granularity === 'week') {
      return `${month} ${day}–`;
    }
    return `${month} ${day}`;
  } catch {
    return '—';
  }
}

// ─── Bar-width clamping ────────────────────────────────────────────────────────

/**
 * clampReportBarWidth — same contract as dashboard-utils.clampBarWidth.
 *
 * Returns a percentage [0, 100] for the proportion bar.
 * Returns 0 when maxValue is 0 (all bars are empty — correct for zero-activity org).
 */
export function clampReportBarWidth(value: number, maxValue: number): number {
  if (maxValue <= 0 || value < 0) return 0;
  return Math.min(100, (value / maxValue) * 100);
}
