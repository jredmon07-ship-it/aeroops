/**
 * lib/maintenance-progress.ts — pure display math for the FC-style maintenance
 * reminder progress bars (no I/O, no Date.now(), no React — mirrors
 * lib/month-grid.ts's purity discipline; unit-tested in __tests__).
 *
 * A bar shows PERCENT REMAINING of a reminder's interval:
 *   - remaining <= 0            → EXPIRED: a FULL red bar with the label.
 *   - pct remaining <= 20%      → amber.
 *   - otherwise                 → green.
 *   - unknown remaining         → no bar (neutral 'unknown' tone).
 *
 * INTERVAL (display heuristic — DISPLAY-ONLY, never a determination): the
 * maintenance_item schema stores the DUE POINT (absolute meter value / date),
 * not the recurrence interval, so the denominator is resolved as:
 *   1. the well-known interval for a "common reminder" title we seed
 *      (COMMON_REMINDER_INTERVALS, case-insensitive), else
 *   2. a conservative default (100 hrs / 365 days).
 * The bar is a visual aid on top of the authoritative remaining hours/days
 * text computed by evaluateMaintenanceDue — the pct never feeds any logic.
 *
 * COMPLIANCE: pure arithmetic on operator-entered thresholds — NOT a computed
 * Part-43/91.409 airworthiness or inspection-due determination.
 */

export type MaintenanceProgressTone = 'expired' | 'warn' | 'ok' | 'unknown';

export interface MaintenanceProgress {
  /** Bar fill percent (0–100). EXPIRED renders a FULL bar (100). */
  fillPct: number;
  /** Percent of the interval remaining, clamped 0–100 (0 when expired/unknown). */
  pctRemaining: number;
  tone: MaintenanceProgressTone;
  /** Short bar label ('EXPIRED' / '42%' / ''). */
  label: string;
  /**
   * Sort key for the 'Remaining' sort: normalized remaining fraction, most
   * urgent first. Expired items sort by how far past due (more past = first);
   * unknown sorts last.
   */
  sortKey: number;
}

/** Amber at or below this percent remaining. */
export const WARN_PCT = 20;

/** Display-interval fallbacks when the title is not a known common reminder. */
export const DEFAULT_INTERVAL_HOURS = 100;
export const DEFAULT_INTERVAL_DAYS = 365;

/**
 * The six "common reminders" the one-click seed creates (plain operator
 * reminder items), with their nominal intervals — also the display-interval
 * lookup for the progress bars. Keys are matched case-insensitively.
 */
export const COMMON_REMINDER_INTERVALS: ReadonlyArray<{
  title: string;
  trackBy: 'hours' | 'date';
  intervalHours?: number;
  intervalDays?: number;
  warnThresholdHours?: number;
  warnLeadDays?: number;
}> = [
  { title: '50 Hour Oil Change', trackBy: 'hours', intervalHours: 50, warnThresholdHours: 10 },
  { title: '100 Hour Inspection', trackBy: 'hours', intervalHours: 100, warnThresholdHours: 10 },
  { title: 'Annual Inspection', trackBy: 'date', intervalDays: 365, warnLeadDays: 30 },
  { title: 'ELT Battery', trackBy: 'date', intervalDays: 365, warnLeadDays: 30 },
  { title: 'Transponder Check', trackBy: 'date', intervalDays: 730, warnLeadDays: 60 },
  { title: 'Pitot/Static Check', trackBy: 'date', intervalDays: 730, warnLeadDays: 60 },
];

/**
 * resolveDisplayInterval — the progress-bar denominator for an item: the
 * known common-reminder interval by title (case-insensitive), else the
 * default for its track basis. PURE; always returns a positive number.
 */
export function resolveDisplayInterval(trackBy: 'hours' | 'date', title: string): number {
  const t = title.trim().toLowerCase();
  const known = COMMON_REMINDER_INTERVALS.find(
    (c) => c.trackBy === trackBy && c.title.toLowerCase() === t,
  );
  if (known) {
    const v = trackBy === 'hours' ? known.intervalHours : known.intervalDays;
    if (v !== undefined && Number.isFinite(v) && v > 0) return v;
  }
  return trackBy === 'hours' ? DEFAULT_INTERVAL_HOURS : DEFAULT_INTERVAL_DAYS;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * computeMaintenanceProgress — the pure bar math. NEVER throws.
 *
 * @param input.trackBy   'hours' | 'date'
 * @param input.title     item title (display-interval lookup)
 * @param input.remaining remainingHours (hours items) / remainingDays (date
 *                        items) from evaluateMaintenanceDue — undefined when
 *                        the status is 'unknown' (no recorded meter).
 */
export function computeMaintenanceProgress(input: {
  trackBy: 'hours' | 'date';
  title: string;
  remaining: number | undefined;
}): MaintenanceProgress {
  const { trackBy, title, remaining } = input;

  if (remaining === undefined || !Number.isFinite(remaining)) {
    return { fillPct: 0, pctRemaining: 0, tone: 'unknown', label: '', sortKey: Number.POSITIVE_INFINITY };
  }

  const interval = resolveDisplayInterval(trackBy, title);
  const fraction = remaining / interval;

  if (remaining <= 0) {
    // EXPIRED: full red bar with the label; more past due sorts first.
    return { fillPct: 100, pctRemaining: 0, tone: 'expired', label: 'EXPIRED', sortKey: fraction };
  }

  // Tone compares the UNROUNDED percentage so the 20% boundary is exact
  // (e.g. 74/365 days = 20.27% is 'ok', not rounded down into 'warn').
  const rawPct = fraction * 100;
  const pct = clampPct(rawPct);
  return {
    fillPct: pct,
    pctRemaining: pct,
    tone: rawPct <= WARN_PCT ? 'warn' : 'ok',
    label: `${pct}%`,
    sortKey: fraction,
  };
}
