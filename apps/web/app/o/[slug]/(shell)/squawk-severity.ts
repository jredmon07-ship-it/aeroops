/**
 * squawk-severity.ts — The squawk severity chip: one label + class map, keyed
 * by @aeroops/core's SquawkSeverity so it cannot drift from the real values
 * (a map keyed by plain strings left the dashboard showing 'medium' and 'high'
 * neutral, because it mapped 'major'/'minor', which are not severities).
 *
 * Colors match the Squawks list chip (maintenance/squawks/_components/
 * squawk-list.tsx), light and dark: low slate, medium amber, high orange,
 * grounding red. Grounding takes the red palette its siblings are built from:
 * the list's `*-destructive` classes are never emitted (the theme has no
 * destructive color), and `text-danger` on its own 10% tint is 4.1:1 in light,
 * under WCAG AA for this 11px label.
 *
 * Zero DOM, React, Next.js, or DB imports — unit-tested in (shell)/__tests__.
 */
import { isSquawkSeverity } from '@aeroops/core';
import type { SquawkSeverity } from '@aeroops/core';

/** Shape shared by every severity chip (the app's tight instrument chip). */
const CHIP_BASE =
  'inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4';

export const SQUAWK_SEVERITY_CHIP: Record<SquawkSeverity, { label: string; cls: string }> = {
  low: {
    label: 'Low',
    cls: 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
  },
  medium: {
    label: 'Medium',
    cls: 'border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200',
  },
  high: {
    label: 'High',
    cls: 'border-orange-200 dark:border-orange-900/50 bg-orange-50 dark:bg-orange-950/40 text-orange-800 dark:text-orange-200',
  },
  grounding: {
    label: 'Grounding',
    cls: 'border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200',
  },
};

/**
 * squawkSeverityChip — label + full className for a severity chip.
 *
 * Takes a plain string because some actions serialize severity as `string`;
 * a value that is not a SquawkSeverity renders as itself in the neutral (low)
 * colors rather than throwing.
 */
export function squawkSeverityChip(severity: string): { label: string; className: string } {
  if (!isSquawkSeverity(severity)) {
    return { label: severity, className: `${CHIP_BASE} ${SQUAWK_SEVERITY_CHIP.low.cls}` };
  }
  const { label, cls } = SQUAWK_SEVERITY_CHIP[severity];
  return { label, className: `${CHIP_BASE} ${cls}` };
}
