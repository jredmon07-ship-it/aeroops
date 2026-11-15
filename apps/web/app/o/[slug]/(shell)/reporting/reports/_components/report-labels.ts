/**
 * report-labels.ts — The words Reports shows for status values.
 *
 * Report rows carry enum keys ('open', 'due_soon', 'ok'); the tables printed
 * them as-is ("open", "due soon", "ok"). These maps give the labels the
 * Squawks list and the Maintenance due pages already show for the same values.
 * A value missing from a map (a status added later) renders as itself rather
 * than as an empty chip.
 *
 * Pure: no I/O, no React. Unit-tested in __tests__/report-labels.test.ts.
 */
import type { MaintenanceDueStatus, SquawkStatus } from '@aeroops/core';

export const SQUAWK_STATUS_LABELS: Record<SquawkStatus, string> = {
  open: 'Open',
  deferred: 'Deferred',
  resolved: 'Resolved',
};

export const DUE_STATUS_LABELS: Record<MaintenanceDueStatus, string> = {
  overdue: 'Overdue',
  due_soon: 'Due soon',
  ok: 'OK',
  unknown: 'No meter yet',
};

function labelFor(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value]! : value;
}

/** squawkStatusLabel — 'open' → 'Open'; an unknown value renders as itself. */
export function squawkStatusLabel(status: string): string {
  return labelFor(SQUAWK_STATUS_LABELS, status);
}

/** dueStatusLabel — 'due_soon' → 'Due soon'; an unknown value renders as itself. */
export function dueStatusLabel(status: string): string {
  return labelFor(DUE_STATUS_LABELS, status);
}
