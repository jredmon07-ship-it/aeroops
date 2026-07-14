/**
 * dues.ts — pure helpers for recurring dues/tuition (Slice DUES-CADENCE,
 * migration 0050). No DB, no I/O — unit-testable.
 *
 * A dues_schedule bills on a cadence anchored to a month of the year. The
 * generation engine runs per calendar month and asks, per schedule, "is this
 * one due THIS month?" — that is isDuesScheduleDue. Monthly is always due (the
 * anchor is irrelevant), so a monthly schedule bills exactly as it did before
 * this slice.
 *
 * The word an operator sees ("Tuition" vs "Dues") is driven by operating mode,
 * so a flight school shows Tuition and a club shows Dues from the one engine.
 */

import type { OperatingMode } from './org-modules.js';

export type DuesCadence = 'monthly' | 'quarterly' | 'semiannual' | 'annual';

export const DUES_CADENCES: readonly DuesCadence[] = ['monthly', 'quarterly', 'semiannual', 'annual'];

/** Months between charges for each cadence. */
const CADENCE_INTERVAL_MONTHS: Record<DuesCadence, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

export function isDuesCadence(value: string): value is DuesCadence {
  return (DUES_CADENCES as readonly string[]).includes(value);
}

/**
 * isDuesScheduleDue — is a schedule of this cadence due in the given calendar
 * month (1–12)?
 *
 *   monthly    → always (anchor ignored).
 *   quarterly  → every 3rd month from the anchor.
 *   semiannual → every 6th month from the anchor.
 *   annual     → only the anchor month.
 *
 * A non-monthly schedule with a missing anchor is treated as NOT due (defensive:
 * the create command + the DB CHECK both require an anchor for non-monthly, so
 * this only guards malformed data — it never silently over-bills).
 */
export function isDuesScheduleDue(
  cadence: DuesCadence,
  anchorMonth: number | null | undefined,
  calendarMonth: number,
): boolean {
  if (cadence === 'monthly') return true;
  if (anchorMonth == null) return false;
  const interval = CADENCE_INTERVAL_MONTHS[cadence];
  return ((((calendarMonth - anchorMonth) % interval) + interval) % interval) === 0;
}

/** How many times per year a cadence bills (for UI copy). */
export function duesChargesPerYear(cadence: DuesCadence): number {
  return 12 / CADENCE_INTERVAL_MONTHS[cadence];
}

/**
 * The monthly-equivalent (MRR contribution) of one schedule, in integer cents:
 * a $600/year membership contributes $50/month, a $130/month dues line
 * contributes $130. Rounded to the nearest cent. Sum across active schedules
 * for the operator's recurring-revenue figure.
 */
export function duesMonthlyEquivalentCents(cadence: DuesCadence, amountCents: number): number {
  return Math.round((amountCents * duesChargesPerYear(cadence)) / 12);
}

/** Display metadata for the cadence picker + labels. */
export const DUES_CADENCE_META: Record<DuesCadence, { label: string; per: string }> = {
  monthly: { label: 'Monthly', per: 'per month' },
  quarterly: { label: 'Quarterly', per: 'per quarter' },
  semiannual: { label: 'Twice a year', per: 'per half-year' },
  annual: { label: 'Annual', per: 'per year' },
};

/**
 * recurringChargeNoun — the word for the recurring per-member charge, by
 * operating mode. A flight school/FBO calls it Tuition; a club calls it Dues.
 * Same engine, different label.
 */
export function recurringChargeNoun(mode: OperatingMode): 'Tuition' | 'Dues' {
  return mode === 'school' ? 'Tuition' : 'Dues';
}

/** English month names, index 0 = January. For the anchor-month picker + labels. */
export const DUES_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** 1-12 -> "January".."December" (falls back to the number if out of range). */
export function duesMonthName(month: number): string {
  return DUES_MONTH_NAMES[month - 1] ?? String(month);
}

/**
 * The rate suffix for an amount line, e.g. "/ month" or "/ year (July)".
 * DUES_CADENCE_META[c].per is "per month"; drop the "per" in favor of "/".
 */
export function duesCadenceSuffix(cadence: DuesCadence, anchorMonth: number | null): string {
  const unit = DUES_CADENCE_META[cadence].per.replace(/^per /, '');
  if (cadence === 'monthly' || anchorMonth == null) return `/ ${unit}`;
  return `/ ${unit} (${duesMonthName(anchorMonth)})`;
}

/** The cadence label for a table cell, e.g. "Monthly" or "Annual (July)". */
export function duesCadenceLabel(cadence: DuesCadence, anchorMonth: number | null): string {
  const label = DUES_CADENCE_META[cadence].label;
  if (cadence === 'monthly' || anchorMonth == null) return label;
  return `${label} (${duesMonthName(anchorMonth)})`;
}
