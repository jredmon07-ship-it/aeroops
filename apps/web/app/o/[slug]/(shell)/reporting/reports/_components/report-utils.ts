/**
 * report-utils.ts — Pure display helpers for Slice R1.2 Operational Reports.
 *
 * NO I/O, NO Next.js imports. Safe to use in RSC and tests.
 *
 * [VERIFY-R1-TZ]: bucketStart values are UTC ISO strings from the server.
 * The labels produced here show UTC dates/weeks — display-only, not localised.
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
 * formatBucketLabel — converts a UTC ISO bucket-start string to a short label.
 *
 * For 'day' granularity: "MMM D"  (e.g. "Jun 5")
 * For 'week' granularity: "MMM D–" (e.g. "Jun 2–") indicating week start.
 *
 * Always uses UTC values from the ISO string (no localisation).
 * Returns '—' on parse failure (never throws).
 *
 * [VERIFY-R1-TZ]: UTC-only; consistent with server bucketing.
 */
export function formatBucketLabel(
  bucketStartIso: string,
  granularity: string,
): string {
  try {
    const d = new Date(bucketStartIso);
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
