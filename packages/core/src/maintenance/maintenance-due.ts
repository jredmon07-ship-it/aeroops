/**
 * maintenance/maintenance-due.ts — pure maintenance-due evaluator (Slice P1.5).
 *
 * The `@aeroops/core` half of the maintenance-due-reminders slice. No I/O, no
 * Drizzle, no React, no Date.now() / Math.random() — every input (including
 * "today") is injected by the caller. Deterministic: same inputs always
 * produce deep-equal outputs. Safe to call in isolation and property-test.
 *
 * COMPLIANCE (HARD LINE — matches ADR-0008 grounding gate + Slice M1 work
 * orders): this function performs ARITHMETIC on operator-entered thresholds
 * against operator-recorded meters/dates. It computes NO FAA/Part-43/91.409
 * airworthiness or inspection-due DETERMINATION. A mechanic/IA still makes
 * the airworthiness call — this only tells the operator "you set a threshold,
 * here is how close you are to it." [VERIFY-P1.5-A]
 *
 * SCOPE:
 *   - 'hours' items: remaining = due_value_hours - current_meter(basis).
 *     overdue  ⇔ remaining <= 0 (the threshold has been reached or passed).
 *     due_soon ⇔ warn_threshold_hours is set AND 0 < remaining <= warn_threshold_hours.
 *     unknown  ⇔ the recorded meter for the item's basis is unavailable (no
 *       closed dispatch ticket has ever recorded it yet, or the item's own
 *       shape is malformed) — NEVER a crash, NEVER silently treated as overdue.
 *   - 'date' items: remainingDays = due_date - today, compared as CALENDAR DAYS
 *     (UTC year/month/day components only — DST- and time-of-day-agnostic;
 *     the caller's `today` may carry any time-of-day/offset and is normalised
 *     internally).
 *     overdue  ⇔ remainingDays <= 0 (due today or already past).
 *     due_soon ⇔ warn_lead_days is set AND 0 < remainingDays <= warn_lead_days.
 *   - Neither arm ever throws. Malformed/inconsistent item shapes (which the
 *     DB CHECK + Zod validation should already prevent) fail SAFE to
 *     'unknown' rather than crashing or silently reporting 'overdue'.
 *
 * MONOTONICITY (hard guardrail, property-tested):
 *   - For a fixed 'hours' item, increasing the recorded meter NEVER moves the
 *     status backward (ok → due_soon → overdue is the only direction).
 *   - For a fixed 'date' item, advancing `today` NEVER moves the status
 *     backward.
 */

import type { MaintenanceTrackBy, MeterBasis } from './enums.js';

// ─── Input shapes ──────────────────────────────────────────────────────────────

/**
 * MaintenanceDueItemInput — the subset of a maintenance_item row needed to
 * evaluate its due status. Caller loads this from the DB; this module
 * performs no I/O.
 */
export interface MaintenanceDueItemInput {
  trackBy: MaintenanceTrackBy;
  /** Required iff trackBy==='hours'; otherwise null. */
  meterBasis: MeterBasis | null;
  /** Required iff trackBy==='hours'; otherwise null. */
  dueValueHours: number | null;
  /** ISO calendar date 'YYYY-MM-DD', required iff trackBy==='date'; otherwise null. */
  dueDate: string | null;
  /** Optional lead — warn when remaining hours <= this. */
  warnThresholdHours: number | null;
  /** Optional lead — warn when remaining days <= this. */
  warnLeadDays: number | null;
}

/** CurrentMetersInput — the aircraft's last-recorded (DISPLAY-ONLY) meters. */
export interface CurrentMetersInput {
  hobbs: number | null;
  tach: number | null;
}

/** MaintenanceDueStatus — the four possible evaluation outcomes. */
export type MaintenanceDueStatus = 'ok' | 'due_soon' | 'overdue' | 'unknown';

/** MaintenanceDueEvaluation — the pure evaluator's output. */
export interface MaintenanceDueEvaluation {
  status: MaintenanceDueStatus;
  /** Set only for 'hours' items with a known meter (ok/due_soon/overdue arms). */
  remainingHours?: number;
  /** Set only for 'date' items (ok/due_soon/overdue arms). */
  remainingDays?: number;
}

// ─── Date helpers (DST-agnostic: UTC calendar-day arithmetic only) ────────────

/** toUtcDayNumber — the number of whole UTC calendar days since the epoch. */
function toUtcDayNumber(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000);
}

/** parseIsoDateOnly — 'YYYY-MM-DD' → UTC day number, or null when malformed. */
function parseIsoDateOnlyToDayNumber(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [, yStr, moStr, dStr] = m;
  const y = Number(yStr);
  const mo = Number(moStr);
  const d = Number(dStr);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  // Date.UTC normalises out-of-range values (e.g. month 13) rather than
  // throwing — reject anything that doesn't round-trip to guard against that.
  const dayNum = Math.floor(Date.UTC(y, mo - 1, d) / 86_400_000);
  const roundTrip = new Date(dayNum * 86_400_000);
  if (
    roundTrip.getUTCFullYear() !== y ||
    roundTrip.getUTCMonth() !== mo - 1 ||
    roundTrip.getUTCDate() !== d
  ) {
    return null;
  }
  return dayNum;
}

// ─── evaluateMaintenanceDue ────────────────────────────────────────────────────

/**
 * evaluateMaintenanceDue — pure arithmetic gate. NEVER throws.
 *
 * @param item          - The maintenance item's due-tracking fields.
 * @param currentMeters - The aircraft's last-recorded meters, or null when
 *                        no meters have ever been recorded for this aircraft.
 * @param today         - The reference "now" for date-based items. Only its
 *                        UTC calendar-date components are used.
 * @returns MaintenanceDueEvaluation — never throws for any input shape.
 */
export function evaluateMaintenanceDue(
  item: MaintenanceDueItemInput,
  currentMeters: CurrentMetersInput | null,
  today: Date,
): MaintenanceDueEvaluation {
  if (item.trackBy === 'hours') {
    // Malformed shape (should be prevented by the DB CHECK + Zod) → unknown,
    // never a crash.
    if (item.meterBasis == null || item.dueValueHours == null || !Number.isFinite(item.dueValueHours)) {
      return { status: 'unknown' };
    }

    const currentMeter = currentMeters == null ? null : currentMeters[item.meterBasis];
    if (currentMeter == null || !Number.isFinite(currentMeter)) {
      // No recorded meter yet for this basis — cannot evaluate. NOT treated
      // as due; NOT a crash.
      return { status: 'unknown' };
    }

    const remainingHours = item.dueValueHours - currentMeter;

    if (remainingHours <= 0) {
      return { status: 'overdue', remainingHours };
    }
    if (
      item.warnThresholdHours != null &&
      Number.isFinite(item.warnThresholdHours) &&
      item.warnThresholdHours >= 0 &&
      remainingHours <= item.warnThresholdHours
    ) {
      return { status: 'due_soon', remainingHours };
    }
    return { status: 'ok', remainingHours };
  }

  if (item.trackBy === 'date') {
    if (item.dueDate == null) {
      return { status: 'unknown' };
    }
    const dueDayNumber = parseIsoDateOnlyToDayNumber(item.dueDate);
    if (dueDayNumber == null) {
      return { status: 'unknown' };
    }

    const todayDayNumber = toUtcDayNumber(today);
    const remainingDays = dueDayNumber - todayDayNumber;

    if (remainingDays <= 0) {
      return { status: 'overdue', remainingDays };
    }
    if (
      item.warnLeadDays != null &&
      Number.isFinite(item.warnLeadDays) &&
      item.warnLeadDays >= 0 &&
      remainingDays <= item.warnLeadDays
    ) {
      return { status: 'due_soon', remainingDays };
    }
    return { status: 'ok', remainingDays };
  }

  // Unreachable for a well-typed MaintenanceTrackBy, but defends against a
  // malformed/untyped item slipping through at a JS boundary — fail safe,
  // never throw.
  return { status: 'unknown' };
}

/**
 * MAINTENANCE_DUE_STATUS_RANK — ordering used by callers (and by the
 * monotonicity property tests) to compare two statuses: ok < due_soon <
 * overdue. 'unknown' is intentionally NOT ranked here — it is only ever
 * produced by missing/malformed input, not by advancing a meter/date, so it
 * is never compared against the other three in the monotonicity property.
 */
export const MAINTENANCE_DUE_STATUS_RANK: Record<'ok' | 'due_soon' | 'overdue', number> = {
  ok: 0,
  due_soon: 1,
  overdue: 2,
};
