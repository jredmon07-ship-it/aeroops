/**
 * optimizer.test.ts — PROPERTY (fast-check) + unit tests for the pure
 * auto-scheduler proposer `proposeSchedule` (Slice 4b §4b tests).
 *
 * This is where the SCHEDULING-4b PROPERTY tests live (the hard guardrail).
 *
 * Deterministic: no Date.now(), no Math.random() — fast-check seeds the only
 * randomness; `now` + `seed` are injected to the pure function.
 *
 * PROPERTIES:
 *   P1 never proposes a conflicting pair (no two emitted proposals share a
 *      resource AND overlap, half-open).
 *   P2 respects handed-in constraints (within an availability window for each
 *      resource; within earliest/latest bounds; within any twilight boundary).
 *   P3 determinism (identical input+seed+now ⇒ deep-equal ProposalSet, twice).
 *   P4 total accounting (every demand id appears EXACTLY once across
 *      proposals ∪ unschedulable).
 *   P5 termination (pathological/over-constrained inputs complete fast).
 * UNIT: empty demands; exact-fit single placement; over-constrained pair;
 *   twilight excludes a night placement; priority ordering when competing.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { proposeSchedule } from '../scheduling/optimizer.js';
import type {
  DemandRequest,
  AvailabilityWindow,
  PerResourceTwilight,
  ProposalSet,
} from '../scheduling/optimizer.js';
import { intervalsOverlap } from '../scheduling/overlap.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY0 = Date.UTC(2026, 5, 19, 0, 0, 0); // injected `now` anchor

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** A small pool of resource ids so demands actually compete. */
const RESOURCE_POOL = ['acft-1', 'acft-2', 'cfi-1', 'cfi-2', 'room-1'];

const resourceArb = fc.constantFrom(...RESOURCE_POOL);

const demandArb = fc.record({
  id: fc.uuid(),
  requiredResourceIds: fc.uniqueArray(resourceArb, { minLength: 1, maxLength: 3 }),
  durationMinutes: fc.integer({ min: 30, max: 180 }),
  earliestStartUtcMs: fc.option(
    fc.integer({ min: 0, max: 12 }).map((h) => DAY0 + h * HOUR),
    { nil: undefined },
  ),
  latestEndUtcMs: fc.option(
    fc.integer({ min: 12, max: 24 }).map((h) => DAY0 + h * HOUR),
    { nil: undefined },
  ),
  priority: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
});

/** Availability windows covering a chunk of the anchor day per resource. */
const windowArb = fc
  .record({
    resourceId: resourceArb,
    startHour: fc.integer({ min: 0, max: 20 }),
    lengthHours: fc.integer({ min: 1, max: 12 }),
  })
  .map<AvailabilityWindow>((w) => ({
    resourceId: w.resourceId,
    startUtcMs: DAY0 + w.startHour * HOUR,
    endUtcMs: DAY0 + (w.startHour + w.lengthHours) * HOUR,
  }));

const inputArb = fc.record({
  demands: fc.array(demandArb, { minLength: 0, maxLength: 12 }),
  availability: fc.array(windowArb, { minLength: 0, maxLength: 10 }),
  twilightBoundaries: fc.option(
    fc.array(
      fc.record({
        resourceId: resourceArb,
        civilDawnUtcMs: fc.option(
          fc.integer({ min: 4, max: 8 }).map((h) => DAY0 + h * HOUR),
          { nil: null },
        ),
        civilDuskUtcMs: fc.option(
          fc.integer({ min: 16, max: 22 }).map((h) => DAY0 + h * HOUR),
          { nil: null },
        ),
      }),
      { maxLength: 5 },
    ),
    { nil: undefined },
  ),
  objective: fc.constantFrom<'maximize_utilization' | 'maximize_sessions_scheduled'>(
    'maximize_utilization',
    'maximize_sessions_scheduled',
  ),
  seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
});

function run(input: Parameters<typeof proposeSchedule>[0]): ProposalSet {
  return proposeSchedule(input);
}

// ─── P1: never proposes a conflicting pair ────────────────────────────────────

describe('P1 — no two emitted proposals share a resource and overlap', () => {
  it('holds for randomized inputs', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const out = run({ ...input, now: DAY0 });
        const ps = out.proposals;
        for (let i = 0; i < ps.length; i++) {
          for (let j = i + 1; j < ps.length; j++) {
            const a = ps[i]!;
            const b = ps[j]!;
            const shared = a.resourceIds.some((r) => b.resourceIds.includes(r));
            if (shared) {
              expect(
                intervalsOverlap(a.startUtcMs, a.endUtcMs, b.startUtcMs, b.endUtcMs),
                `proposals ${a.demandId} & ${b.demandId} share a resource and overlap`,
              ).toBe(false);
            }
          }
        }
      }),
      { numRuns: 400 },
    );
  });
});

// ─── P2: respects handed-in constraints ───────────────────────────────────────

describe('P2 — every proposal is within availability, bounds, and twilight', () => {
  it('holds for randomized inputs', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const out = run({ ...input, now: DAY0 });
        const demandById = new Map(input.demands.map((d) => [d.id, d]));
        const twById = new Map(
          (input.twilightBoundaries ?? []).map((t) => [t.resourceId, t]),
        );

        for (const p of out.proposals) {
          const d = demandById.get(p.demandId)!;
          // Duration preserved.
          expect(p.endUtcMs - p.startUtcMs).toBe(d.durationMinutes * MIN);
          // Bounds.
          if (d.earliestStartUtcMs !== undefined) {
            expect(p.startUtcMs).toBeGreaterThanOrEqual(d.earliestStartUtcMs);
          }
          if (d.latestEndUtcMs !== undefined) {
            expect(p.endUtcMs).toBeLessThanOrEqual(d.latestEndUtcMs);
          }
          // Availability: each resource fully covered by SOME window.
          for (const resId of d.requiredResourceIds) {
            const wins = input.availability.filter((w) => w.resourceId === resId);
            const covered = wins.some(
              (w) => p.startUtcMs >= w.startUtcMs && p.endUtcMs <= w.endUtcMs,
            );
            expect(covered, `resource ${resId} not in any window`).toBe(true);
            // Twilight.
            const tw = twById.get(resId);
            if (tw) {
              if (tw.civilDawnUtcMs !== null) {
                expect(p.startUtcMs).toBeGreaterThanOrEqual(tw.civilDawnUtcMs);
              }
              if (tw.civilDuskUtcMs !== null) {
                expect(p.endUtcMs).toBeLessThanOrEqual(tw.civilDuskUtcMs);
              }
            }
          }
        }
      }),
      { numRuns: 400 },
    );
  });
});

// ─── P3: determinism ──────────────────────────────────────────────────────────

describe('P3 — identical (input, seed, now) ⇒ deep-equal ProposalSet', () => {
  it('twice equal', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const a = run({ ...input, now: DAY0 });
        const b = run({ ...input, now: DAY0 });
        expect(a).toEqual(b);
      }),
      { numRuns: 300 },
    );
  });
});

// ─── P4: total accounting ─────────────────────────────────────────────────────

describe('P4 — every demand id appears exactly once across proposals ∪ unschedulable', () => {
  it('no loss, no duplication', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const out = run({ ...input, now: DAY0 });
        const ids = [
          ...out.proposals.map((p) => p.demandId),
          ...out.unschedulable.map((u) => u.demandId),
        ];
        // Same multiset as input demand ids.
        const inIds = input.demands.map((d) => d.id).sort();
        expect([...ids].sort()).toEqual(inIds);
        // No duplicates.
        expect(new Set(ids).size).toBe(ids.length);
      }),
      { numRuns: 400 },
    );
  });
});

// ─── P5: termination on pathological input ────────────────────────────────────

describe('P5 — bounded termination on over-constrained inputs', () => {
  it('many mutually-exclusive demands on one window complete fast', () => {
    // 60 demands all needing the same single aircraft + one 2-hour window: at
    // most a handful fit; the rest are over_constrained. Must finish quickly.
    const demands: DemandRequest[] = Array.from({ length: 60 }, (_, i) => ({
      id: `d-${String(i).padStart(3, '0')}`,
      requiredResourceIds: ['acft-1'],
      durationMinutes: 60,
      priority: i % 7,
    }));
    const availability: AvailabilityWindow[] = [
      { resourceId: 'acft-1', startUtcMs: DAY0, endUtcMs: DAY0 + 2 * HOUR },
    ];
    const t0 = Date.now();
    const out = proposeSchedule({
      demands,
      availability,
      objective: 'maximize_sessions_scheduled',
      seed: 1,
      now: DAY0,
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    // Exactly 2 one-hour sessions fit the 2-hour window.
    expect(out.proposals.length).toBe(2);
    expect(out.proposals.length + out.unschedulable.length).toBe(60);
  });
});

// ─── UNIT ─────────────────────────────────────────────────────────────────────

describe('unit — empty + exact-fit + over-constrained + twilight + priority', () => {
  it('empty demands → empty proposals, empty unschedulable', () => {
    const out = proposeSchedule({
      demands: [],
      availability: [{ resourceId: 'acft-1', startUtcMs: DAY0, endUtcMs: DAY0 + HOUR }],
      objective: 'maximize_utilization',
      seed: 0,
      now: DAY0,
    });
    expect(out.proposals).toEqual([]);
    expect(out.unschedulable).toEqual([]);
  });

  it('single demand with one exact-fit window → placed at the window start', () => {
    const out = proposeSchedule({
      demands: [{ id: 'd1', requiredResourceIds: ['acft-1'], durationMinutes: 60 }],
      availability: [{ resourceId: 'acft-1', startUtcMs: DAY0, endUtcMs: DAY0 + HOUR }],
      objective: 'maximize_utilization',
      seed: 0,
      now: DAY0,
    });
    expect(out.unschedulable).toEqual([]);
    expect(out.proposals).toEqual([
      { demandId: 'd1', resourceIds: ['acft-1'], startUtcMs: DAY0, endUtcMs: DAY0 + HOUR },
    ]);
  });

  it('over-constrained pair (shared resource, one window) → one placed + one unschedulable', () => {
    const out = proposeSchedule({
      demands: [
        { id: 'd1', requiredResourceIds: ['acft-1'], durationMinutes: 60 },
        { id: 'd2', requiredResourceIds: ['acft-1'], durationMinutes: 60 },
      ],
      availability: [{ resourceId: 'acft-1', startUtcMs: DAY0, endUtcMs: DAY0 + HOUR }],
      objective: 'maximize_sessions_scheduled',
      seed: 0,
      now: DAY0,
    });
    expect(out.proposals.length).toBe(1);
    expect(out.unschedulable.length).toBe(1);
    expect(out.unschedulable[0]!.reason).toBe('over_constrained');
  });

  it('demand with no window at all → no_feasible_window', () => {
    const out = proposeSchedule({
      demands: [{ id: 'd1', requiredResourceIds: ['acft-9'], durationMinutes: 60 }],
      availability: [{ resourceId: 'acft-1', startUtcMs: DAY0, endUtcMs: DAY0 + HOUR }],
      objective: 'maximize_utilization',
      seed: 0,
      now: DAY0,
    });
    expect(out.proposals).toEqual([]);
    expect(out.unschedulable).toEqual([{ demandId: 'd1', reason: 'no_feasible_window' }]);
  });

  it('twilight boundary excludes a night placement', () => {
    // Window is all-day; twilight dusk at 20:00 forces the 19:30-21:00 attempt out,
    // so the only feasible spot is earlier. With dusk at 20:00 and a 90-min demand
    // bounded earliest 19:00, end would be 20:30 > dusk ⇒ unschedulable.
    const out = proposeSchedule({
      demands: [
        {
          id: 'night',
          requiredResourceIds: ['acft-1'],
          durationMinutes: 90,
          earliestStartUtcMs: DAY0 + 19 * HOUR,
        },
      ],
      availability: [{ resourceId: 'acft-1', startUtcMs: DAY0, endUtcMs: DAY0 + 24 * HOUR }],
      twilightBoundaries: [
        { resourceId: 'acft-1', civilDawnUtcMs: DAY0 + 5 * HOUR, civilDuskUtcMs: DAY0 + 20 * HOUR },
      ],
      objective: 'maximize_utilization',
      seed: 0,
      now: DAY0,
    });
    expect(out.proposals).toEqual([]);
    expect(out.unschedulable).toEqual([{ demandId: 'night', reason: 'no_feasible_window' }]);
  });

  it('twilight: a daytime demand still places within the dawn/dusk band', () => {
    const out = proposeSchedule({
      demands: [{ id: 'day', requiredResourceIds: ['acft-1'], durationMinutes: 60 }],
      availability: [{ resourceId: 'acft-1', startUtcMs: DAY0, endUtcMs: DAY0 + 24 * HOUR }],
      twilightBoundaries: [
        { resourceId: 'acft-1', civilDawnUtcMs: DAY0 + 6 * HOUR, civilDuskUtcMs: DAY0 + 20 * HOUR },
      ],
      objective: 'maximize_utilization',
      seed: 0,
      now: DAY0,
    });
    // Earliest feasible start = civil dawn (06:00), since before that is excluded.
    expect(out.proposals).toEqual([
      { demandId: 'day', resourceIds: ['acft-1'], startUtcMs: DAY0 + 6 * HOUR, endUtcMs: DAY0 + 7 * HOUR },
    ]);
  });

  it('priority ordering: higher priority placed first when they compete', () => {
    const out = proposeSchedule({
      demands: [
        { id: 'low', requiredResourceIds: ['acft-1'], durationMinutes: 60, priority: 1 },
        { id: 'high', requiredResourceIds: ['acft-1'], durationMinutes: 60, priority: 9 },
      ],
      availability: [{ resourceId: 'acft-1', startUtcMs: DAY0, endUtcMs: DAY0 + HOUR }],
      objective: 'maximize_sessions_scheduled',
      seed: 0,
      now: DAY0,
    });
    expect(out.proposals.length).toBe(1);
    expect(out.proposals[0]!.demandId).toBe('high');
    expect(out.unschedulable).toEqual([{ demandId: 'low', reason: 'over_constrained' }]);
  });

  it('backtracking: a high-priority demand displaces a lower one to a later slot', () => {
    // One aircraft, one 2-hour window. Place low (60m) first; it lands at DAY0.
    // Then a high-priority 60m demand also wants acft-1; greedy earliest for high
    // is DAY0+1h (free), so no displacement needed — both fit. To force a swap,
    // give high a latest bound that only the early slot satisfies.
    const out = proposeSchedule({
      demands: [
        { id: 'low', requiredResourceIds: ['acft-1'], durationMinutes: 60, priority: 1 },
        {
          id: 'high',
          requiredResourceIds: ['acft-1'],
          durationMinutes: 60,
          priority: 9,
          latestEndUtcMs: DAY0 + HOUR, // must occupy the FIRST hour
        },
      ],
      availability: [{ resourceId: 'acft-1', startUtcMs: DAY0, endUtcMs: DAY0 + 2 * HOUR }],
      objective: 'maximize_sessions_scheduled',
      seed: 0,
      now: DAY0,
    });
    // Both should be placed: high in [DAY0, DAY0+1h), low displaced to [DAY0+1h, DAY0+2h).
    expect(out.unschedulable).toEqual([]);
    const byId = new Map(out.proposals.map((p) => [p.demandId, p]));
    expect(byId.get('high')!.startUtcMs).toBe(DAY0);
    expect(byId.get('low')!.startUtcMs).toBe(DAY0 + HOUR);
  });

  it('multi-resource demand: both resources must be free and covered', () => {
    const out = proposeSchedule({
      demands: [{ id: 'd1', requiredResourceIds: ['acft-1', 'cfi-1'], durationMinutes: 60 }],
      availability: [
        { resourceId: 'acft-1', startUtcMs: DAY0, endUtcMs: DAY0 + 8 * HOUR },
        { resourceId: 'cfi-1', startUtcMs: DAY0 + 3 * HOUR, endUtcMs: DAY0 + 8 * HOUR },
      ],
      objective: 'maximize_utilization',
      seed: 0,
      now: DAY0,
    });
    // cfi-1 only available from 03:00 ⇒ earliest joint slot is 03:00.
    expect(out.proposals).toEqual([
      {
        demandId: 'd1',
        resourceIds: ['acft-1', 'cfi-1'],
        startUtcMs: DAY0 + 3 * HOUR,
        endUtcMs: DAY0 + 4 * HOUR,
      },
    ]);
  });
});
