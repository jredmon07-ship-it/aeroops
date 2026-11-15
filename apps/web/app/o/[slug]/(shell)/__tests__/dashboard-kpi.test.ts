/**
 * dashboard-kpi.test.ts — Pure unit tests for the dashboard KPI sub-labels
 * (dashboard-kpi.ts, used by the KPI row in (shell)/page.tsx).
 *
 * The bug: Flight hours and Reservations rendered the design spec's template
 * text "no … in period" literally when their value was 0, and Reservations
 * said "incl. upcoming" although its window ends now.
 *
 * COVERAGE:
 *   1. Zero → "no {what the card counts} in period" for every card
 *   2. Non-zero → what the number counts (Flights unchanged)
 *   3. No label is a template placeholder (no "…"), and none and some differ
 *
 * PURE: no DOM, no Next.js, no DB.
 */

import { describe, it, expect } from 'vitest';
import { kpiSubLabel, KPI_SUB_LABELS } from '../dashboard-kpi';
import type { DashboardKpi } from '../dashboard-kpi';

const KPIS = Object.keys(KPI_SUB_LABELS) as DashboardKpi[];

describe('1. zero → "no … in period", filled in per card', () => {
  it('Flights', () => {
    expect(kpiSubLabel('flights', 0)).toBe('no flights in period');
  });

  it('Flight hours', () => {
    expect(kpiSubLabel('flightHours', 0)).toBe('no flight hours in period');
  });

  it('Reservations', () => {
    expect(kpiSubLabel('reservations', 0)).toBe('no reservations in period');
  });
});

describe('2. non-zero → what the number counts', () => {
  it('Flights keeps "completed dispatches"', () => {
    expect(kpiSubLabel('flights', 3)).toBe('completed dispatches');
  });

  it('Flight hours keeps "utilization hrs", including fractional hours', () => {
    expect(kpiSubLabel('flightHours', 12.4)).toBe('utilization hrs');
    expect(kpiSubLabel('flightHours', 0.1)).toBe('utilization hrs');
  });

  it('Reservations says "excl. cancelled" (the window ends now, so never "upcoming")', () => {
    expect(kpiSubLabel('reservations', 7)).toBe('excl. cancelled');
    expect(kpiSubLabel('reservations', 7)).not.toMatch(/upcoming/);
  });
});

describe('3. every label is real copy', () => {
  it('covers exactly the three KPI cards', () => {
    expect(KPIS.sort()).toEqual(['flightHours', 'flights', 'reservations']);
  });

  it('no label contains an ellipsis placeholder', () => {
    for (const kpi of KPIS) {
      for (const label of [kpiSubLabel(kpi, 0), kpiSubLabel(kpi, 1)]) {
        expect(label, kpi).not.toContain('…');
        expect(label, kpi).not.toContain('...');
        expect(label.trim(), kpi).not.toBe('');
      }
    }
  });

  it('every zero label reads "no <noun> in period", and differs from the non-zero label', () => {
    for (const kpi of KPIS) {
      expect(kpiSubLabel(kpi, 0), kpi).toMatch(/^no [a-z][a-z ]* in period$/);
      expect(kpiSubLabel(kpi, 0), kpi).not.toBe(kpiSubLabel(kpi, 1));
    }
  });
});
