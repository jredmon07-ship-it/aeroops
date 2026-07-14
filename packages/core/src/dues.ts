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
