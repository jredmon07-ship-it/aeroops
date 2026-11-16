/**
 * dashboard-kpi.ts — Pure sub-label helper for the dashboard's KPI row
 * (section C of page.tsx: Flights / Flight hours / Reservations).
 *
 * Zero DOM, React, Next.js, or DB imports. Co-located with the other (shell)
 * pure helpers and unit-tested in (shell)/__tests__.
 */

/** The three range-scoped KPI cards. */
export type DashboardKpi = 'flights' | 'flightHours' | 'reservations';

/**
 * KPI_SUB_LABELS — the line under each KPI value.
 *   none — the value is 0: "no {what the card counts} in period" (the design
 *          spec's "no … in period", filled in per card).
 *   some — names what the number counts.
 *
 * Reservations counts non-cancelled reservations overlapping the window, and
 * the window ends now (the viewer's last N calendar days, from local midnight
 * up to now), so it never includes upcoming bookings: "excl. cancelled", not
 * "incl. upcoming".
 */
export const KPI_SUB_LABELS: Record<DashboardKpi, { none: string; some: string }> = {
  flights: { none: 'no flights in period', some: 'completed dispatches' },
  flightHours: { none: 'no flight hours in period', some: 'utilization hrs' },
  reservations: { none: 'no reservations in period', some: 'excl. cancelled' },
};

/** kpiSubLabel — the sub-label for a KPI card showing `value`. */
export function kpiSubLabel(kpi: DashboardKpi, value: number): string {
  return value === 0 ? KPI_SUB_LABELS[kpi].none : KPI_SUB_LABELS[kpi].some;
}
