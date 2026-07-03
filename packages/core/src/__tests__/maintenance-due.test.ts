/**
 * maintenance-due.test.ts — unit + property tests for the pure maintenance-due
 * evaluator (Slice P1.5, the hard-guardrail property tests per CLAUDE.md:
 * "conflict detection, policy evaluation, flight-time derivation, the
 * grounding gate, the twilight calc/gate, AND the optimizer get
 * property-based tests" — maintenance-due arithmetic joins that list).
 *
 * Deterministic: no Date.now()/Math.random() — fast-check seeds the only
 * randomness and every input (including "today") is injected.
 *
 * COVERAGE:
 *   Property (fast-check):
 *     M1  monotonic (hours): increasing the recorded meter never moves the
 *         status backward (ok → due_soon → overdue is the only direction).
 *     M2  monotonic (date): advancing `today` never moves the status backward.
 *     M3  boundary correctness (hours): remaining<=0 ⇔ overdue;
 *         0<remaining<=warnThresholdHours ⇔ due_soon; else ok.
 *     M4  boundary correctness (date): remainingDays<=0 ⇔ overdue;
 *         0<remainingDays<=warnLeadDays ⇔ due_soon; else ok.
 *     M5  null-safety: never throws for any well-typed or malformed input.
 *     M6  purity: same input twice ⇒ deep-equal output.
 *   Unit:
 *     - null meters / missing meter for basis → unknown (never overdue/crash)
 *     - malformed dueDate string → unknown (never crash)
 *     - date arithmetic across a month boundary and a year boundary
 *     - DST-agnostic: a `today` with a non-UTC-midnight time-of-day still
 *       compares by calendar date only
 *     - no warn threshold set → never due_soon, only ok/overdue
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  evaluateMaintenanceDue,
  MAINTENANCE_DUE_STATUS_RANK,
} from '../maintenance/maintenance-due.js';
import type {
  MaintenanceDueItemInput,
  CurrentMetersInput,
  MaintenanceDueStatus,
} from '../maintenance/maintenance-due.js';

// ─── Generators ──────────────────────────────────────────────────────────────

const hoursItemArb = (dueValueHours: number, warnThresholdHours: number | null) =>
  fc.constantFrom<'hobbs' | 'tach'>('hobbs', 'tach').map(
    (basis): MaintenanceDueItemInput => ({
      trackBy: 'hours',
      meterBasis: basis,
      dueValueHours,
      dueDate: null,
      warnThresholdHours,
      warnLeadDays: null,
    }),
  );

function dateItem(dueDate: string, warnLeadDays: number | null): MaintenanceDueItemInput {
  return {
    trackBy: 'date',
    meterBasis: null,
    dueValueHours: null,
    dueDate,
    warnThresholdHours: null,
    warnLeadDays,
  };
}

function metersFor(basis: 'hobbs' | 'tach', value: number): CurrentMetersInput {
  return basis === 'hobbs' ? { hobbs: value, tach: null } : { hobbs: null, tach: value };
}

function rank(status: MaintenanceDueStatus): number | undefined {
  return status === 'unknown' ? undefined : MAINTENANCE_DUE_STATUS_RANK[status];
}

// UTC day helper for building `today` fixtures deterministically.
function utcDate(y: number, m: number, d: number, hh = 0, mm = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, hh, mm));
}
function isoDate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Property tests
// ════════════════════════════════════════════════════════════════════════════

describe('evaluateMaintenanceDue — properties', () => {
  it('M1: monotonic over increasing meter reading (hours items)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 10_000, noNaN: true }),
        fc.oneof(fc.constant(null), fc.double({ min: 0, max: 500, noNaN: true })),
        fc.double({ min: 0, max: 10_000, noNaN: true }),
        fc.double({ min: 0, max: 10_000, noNaN: true }),
        (dueValueHours, warnThresholdHours, meterA, meterB) => {
          const [lo, hi] = meterA <= meterB ? [meterA, meterB] : [meterB, meterA];
          const item: MaintenanceDueItemInput = {
            trackBy: 'hours',
            meterBasis: 'hobbs',
            dueValueHours,
            dueDate: null,
            warnThresholdHours,
            warnLeadDays: null,
          };
          const today = utcDate(2026, 7, 1);
          const evalLo = evaluateMaintenanceDue(item, { hobbs: lo, tach: null }, today);
          const evalHi = evaluateMaintenanceDue(item, { hobbs: hi, tach: null }, today);
          const rLo = rank(evalLo.status);
          const rHi = rank(evalHi.status);
          // Both known (hours items with a numeric meter are always known).
          expect(rLo).toBeDefined();
          expect(rHi).toBeDefined();
          expect(rHi! >= rLo!).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('M2: monotonic over advancing "today" (date items)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -3650, max: 3650 }), // due-day offset from an anchor
        fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 400 })),
        fc.integer({ min: -3650, max: 3650 }),
        fc.integer({ min: -3650, max: 3650 }),
        (dueOffset, warnLeadDays, offsetA, offsetB) => {
          const [loOffset, hiOffset] = offsetA <= offsetB ? [offsetA, offsetB] : [offsetB, offsetA];
          const anchor = Date.UTC(2026, 0, 1) / 86_400_000; // epoch day number
          const dueDay = anchor + dueOffset;
          const dueDate = new Date(dueDay * 86_400_000);
          const iso = isoDate(dueDate.getUTCFullYear(), dueDate.getUTCMonth() + 1, dueDate.getUTCDate());
          const item = dateItem(iso, warnLeadDays);

          const todayLo = new Date((anchor + loOffset) * 86_400_000);
          const todayHi = new Date((anchor + hiOffset) * 86_400_000);

          const evalLo = evaluateMaintenanceDue(item, null, todayLo);
          const evalHi = evaluateMaintenanceDue(item, null, todayHi);
          const rLo = rank(evalLo.status);
          const rHi = rank(evalHi.status);
          expect(rLo).toBeDefined();
          expect(rHi).toBeDefined();
          expect(rHi! >= rLo!).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('M3: boundary correctness (hours)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 5_000, noNaN: true }),
        fc.double({ min: 0, max: 500, noNaN: true }),
        fc.double({ min: -1_000, max: 6_000, noNaN: true }),
        (dueValueHours, warnThresholdHours, currentMeter) => {
          const item: MaintenanceDueItemInput = {
            trackBy: 'hours',
            meterBasis: 'hobbs',
            dueValueHours,
            dueDate: null,
            warnThresholdHours,
            warnLeadDays: null,
          };
          const result = evaluateMaintenanceDue(item, { hobbs: currentMeter, tach: null }, utcDate(2026, 7, 1));
          const remaining = dueValueHours - currentMeter;
          if (remaining <= 0) {
            expect(result.status).toBe('overdue');
          } else if (remaining <= warnThresholdHours) {
            expect(result.status).toBe('due_soon');
          } else {
            expect(result.status).toBe('ok');
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('M4: boundary correctness (date)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -365, max: 365 }),
        fc.integer({ min: 0, max: 400 }),
        (remainingDaysTarget, warnLeadDays) => {
          const anchor = Date.UTC(2026, 0, 1) / 86_400_000;
          const dueDay = anchor + remainingDaysTarget;
          const dueDate = new Date(dueDay * 86_400_000);
          const iso = isoDate(dueDate.getUTCFullYear(), dueDate.getUTCMonth() + 1, dueDate.getUTCDate());
          const item = dateItem(iso, warnLeadDays);
          const today = new Date(anchor * 86_400_000);
          const result = evaluateMaintenanceDue(item, null, today);
          if (remainingDaysTarget <= 0) {
            expect(result.status).toBe('overdue');
          } else if (remainingDaysTarget <= warnLeadDays) {
            expect(result.status).toBe('due_soon');
          } else {
            expect(result.status).toBe('ok');
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('M5: null-safety — never throws for any generated input', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'hours' | 'date'>('hours', 'date'),
        fc.oneof(fc.constant(null), fc.constantFrom<'hobbs' | 'tach'>('hobbs', 'tach')),
        fc.oneof(fc.constant(null), fc.double({ noNaN: true })),
        fc.oneof(fc.constant(null), fc.string()),
        fc.oneof(fc.constant(null), fc.double({ noNaN: true })),
        fc.oneof(fc.constant(null), fc.integer()),
        fc.oneof(
          fc.constant(null),
          fc.record({
            hobbs: fc.oneof(fc.constant(null), fc.double({ noNaN: true })),
            tach: fc.oneof(fc.constant(null), fc.double({ noNaN: true })),
          }),
        ),
        (trackBy, meterBasis, dueValueHours, dueDate, warnThresholdHours, warnLeadDays, currentMeters) => {
          const item: MaintenanceDueItemInput = {
            trackBy,
            meterBasis,
            dueValueHours,
            dueDate,
            warnThresholdHours,
            warnLeadDays,
          };
          expect(() => evaluateMaintenanceDue(item, currentMeters, utcDate(2026, 7, 1))).not.toThrow();
        },
      ),
      { numRuns: 500 },
    );
  });

  it('M6: purity — same input twice yields deep-equal output', () => {
    fc.assert(
      fc.property(hoursItemArb(500, 25), fc.double({ min: 0, max: 1000, noNaN: true }), (item, meter) => {
        const meters = metersFor(item.meterBasis!, meter);
        const today = utcDate(2026, 7, 1);
        const a = evaluateMaintenanceDue(item, meters, today);
        const b = evaluateMaintenanceDue(item, meters, today);
        expect(a).toEqual(b);
      }),
      { numRuns: 100 },
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Unit tests
// ════════════════════════════════════════════════════════════════════════════

describe('evaluateMaintenanceDue — unit', () => {
  const today = utcDate(2026, 7, 1);

  it('null currentMeters (no recorded meter yet) → unknown, never overdue', () => {
    const item: MaintenanceDueItemInput = {
      trackBy: 'hours',
      meterBasis: 'hobbs',
      dueValueHours: 100,
      dueDate: null,
      warnThresholdHours: 10,
      warnLeadDays: null,
    };
    expect(evaluateMaintenanceDue(item, null, today)).toEqual({ status: 'unknown' });
  });

  it('meter recorded for the OTHER basis (e.g. tach-tracked item, only hobbs recorded) → unknown', () => {
    const item: MaintenanceDueItemInput = {
      trackBy: 'hours',
      meterBasis: 'tach',
      dueValueHours: 100,
      dueDate: null,
      warnThresholdHours: null,
      warnLeadDays: null,
    };
    expect(evaluateMaintenanceDue(item, { hobbs: 50, tach: null }, today)).toEqual({ status: 'unknown' });
  });

  it('malformed dueDate string → unknown, never a crash', () => {
    const item = dateItem('not-a-date', 30);
    expect(evaluateMaintenanceDue(item, null, today)).toEqual({ status: 'unknown' });
  });

  it('due exactly at meter (remaining=0) → overdue', () => {
    const item: MaintenanceDueItemInput = {
      trackBy: 'hours',
      meterBasis: 'hobbs',
      dueValueHours: 100,
      dueDate: null,
      warnThresholdHours: 10,
      warnLeadDays: null,
    };
    const r = evaluateMaintenanceDue(item, { hobbs: 100, tach: null }, today);
    expect(r).toEqual({ status: 'overdue', remainingHours: 0 });
  });

  it('due today (date item, remainingDays=0) → overdue', () => {
    const item = dateItem(isoDate(2026, 7, 1), 30);
    const r = evaluateMaintenanceDue(item, null, today);
    expect(r).toEqual({ status: 'overdue', remainingDays: 0 });
  });

  it('date arithmetic across a month boundary', () => {
    // today = 2026-01-28, due = 2026-02-02 → 5 days remaining.
    const item = dateItem(isoDate(2026, 2, 2), 7);
    const r = evaluateMaintenanceDue(item, null, utcDate(2026, 1, 28));
    expect(r).toEqual({ status: 'due_soon', remainingDays: 5 });
  });

  it('date arithmetic across a year boundary', () => {
    // today = 2026-12-29, due = 2027-01-03 → 5 days remaining.
    const item = dateItem(isoDate(2027, 1, 3), 10);
    const r = evaluateMaintenanceDue(item, null, utcDate(2026, 12, 29));
    expect(r).toEqual({ status: 'due_soon', remainingDays: 5 });
  });

  it('DST-agnostic: a "today" with a non-midnight, non-UTC-friendly time-of-day still compares by calendar date', () => {
    // 23:59 UTC on 2026-07-01 is still "2026-07-01" for calendar-day purposes.
    const item = dateItem(isoDate(2026, 7, 2), 5);
    const r = evaluateMaintenanceDue(item, null, utcDate(2026, 7, 1, 23, 59));
    expect(r).toEqual({ status: 'due_soon', remainingDays: 1 });
  });

  it('no warn threshold set (hours) → never due_soon, only ok/overdue', () => {
    const item: MaintenanceDueItemInput = {
      trackBy: 'hours',
      meterBasis: 'hobbs',
      dueValueHours: 100,
      dueDate: null,
      warnThresholdHours: null,
      warnLeadDays: null,
    };
    expect(evaluateMaintenanceDue(item, { hobbs: 99, tach: null }, today).status).toBe('ok');
    expect(evaluateMaintenanceDue(item, { hobbs: 100, tach: null }, today).status).toBe('overdue');
  });

  it('no warn lead set (date) → never due_soon, only ok/overdue', () => {
    const item = dateItem(isoDate(2026, 7, 10), null);
    expect(evaluateMaintenanceDue(item, null, utcDate(2026, 7, 1)).status).toBe('ok');
    expect(evaluateMaintenanceDue(item, null, utcDate(2026, 7, 10)).status).toBe('overdue');
  });

  it('well past due (hours) → overdue with negative remaining', () => {
    const item: MaintenanceDueItemInput = {
      trackBy: 'hours',
      meterBasis: 'tach',
      dueValueHours: 50,
      dueDate: null,
      warnThresholdHours: 5,
      warnLeadDays: null,
    };
    const r = evaluateMaintenanceDue(item, { hobbs: null, tach: 75 }, today);
    expect(r).toEqual({ status: 'overdue', remainingHours: -25 });
  });
});
