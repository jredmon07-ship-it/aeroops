/**
 * policy.test.ts — unit + property tests for the pure booking-policy predicate.
 *
 * This is where the SCHED-2a.2 core PROPERTY tests live (ADR-0005 invariant 2 /
 * spec §5 — hard guardrail). Mirrors overlap.test.ts (vitest + fast-check).
 *
 * Half-open `[start, end)` for blackouts: adjacency is NOT a violation. All four
 * rules use strict inequalities, so a value exactly at the limit is OK. `now` is
 * injected — the predicate has no internal clock.
 *
 * SCOPE AMENDMENT (2026-06-16): FOUR rules only. PB-6 (missing-tag) is DEFERRED.
 *
 * COVERAGE:
 *   Unit:
 *     - null policy ⇒ [] (no blackouts); null policy + blackout ⇒ only blackout
 *     - each rule isolated: over / at / under (equality boundary ⇒ OK)
 *     - blackout adjacency both directions ⇒ no violation
 *     - multiple overlapping blackouts ⇒ one violation each, input order
 *     - all-rules-at-once (no short-circuit) ⇒ all violations, rule order
 *     - `now` determinism (varying now flips advance/lead, fixed otherwise)
 *     - carried limit + actual values
 *   Property (fast-check):
 *     - PB-1 no-policy ⇒ only blackout_overlap (never a policy-rule violation)
 *     - PB-2 order-independence: permuting blackouts ⇒ same violation SET
 *     - PB-3 blackout adjacency is never a violation
 *     - PB-4 blackout_overlap ⟺ intervalsOverlap
 *     - PB-5 duration monotonicity: the boundary flips exactly once
 *     - PB-7 monotone-in-now for advance & lead: each flips exactly once
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { evaluateBookingPolicy } from '../policy.js';
import type { BookingPolicy, BlackoutWindow, PolicyViolation } from '../policy.js';
import { intervalsOverlap } from '../overlap.js';

const MIN = 60_000;
const DAY = 86_400_000;
const RID = 'ac-1';

/** A candidate `[start, start+durMin*60000)` for resource RID. */
function candidate(start: number, durMin: number) {
  return { resourceId: RID, start, end: start + durMin * MIN };
}

const kinds = (vs: PolicyViolation[]) => vs.map((v) => v.kind);

// ─── Unit: null policy ───────────────────────────────────────────────────────

describe('evaluateBookingPolicy — null policy', () => {
  it('null policy, no blackouts ⇒ []', () => {
    expect(evaluateBookingPolicy(candidate(0, 60), null, [], 0)).toEqual([]);
  });

  it('null policy with an overlapping blackout ⇒ only blackout_overlap', () => {
    const out = evaluateBookingPolicy(candidate(0, 60), null, [{ start: 30 * MIN, end: 90 * MIN }], 0);
    expect(kinds(out)).toEqual(['blackout_overlap']);
    expect(out[0]).toMatchObject({ resourceId: RID, blackoutStart: 30 * MIN, blackoutEnd: 90 * MIN });
  });

  it('null policy with a non-overlapping blackout ⇒ []', () => {
    expect(
      evaluateBookingPolicy(candidate(0, 60), null, [{ start: 120 * MIN, end: 180 * MIN }], 0),
    ).toEqual([]);
  });
});

// ─── Unit: max_duration_exceeded ─────────────────────────────────────────────

describe('evaluateBookingPolicy — max_duration_exceeded', () => {
  const policy: BookingPolicy = { maxDurationMinutes: 120, maxAdvanceDays: null, minAdvanceMinutes: null };

  it('over the limit ⇒ violation carrying limit + actual', () => {
    const out = evaluateBookingPolicy(candidate(0, 121), policy, [], 0);
    expect(kinds(out)).toEqual(['max_duration_exceeded']);
    expect(out[0]).toEqual({
      kind: 'max_duration_exceeded',
      resourceId: RID,
      limitMinutes: 120,
      actualMinutes: 121,
    });
  });

  it('exactly at the limit ⇒ OK (strict >)', () => {
    expect(evaluateBookingPolicy(candidate(0, 120), policy, [], 0)).toEqual([]);
  });

  it('under the limit ⇒ OK', () => {
    expect(evaluateBookingPolicy(candidate(0, 60), policy, [], 0)).toEqual([]);
  });

  it('null maxDurationMinutes ⇒ rule skipped', () => {
    const p: BookingPolicy = { maxDurationMinutes: null, maxAdvanceDays: null, minAdvanceMinutes: null };
    expect(evaluateBookingPolicy(candidate(0, 100000), p, [], 0)).toEqual([]);
  });
});

// ─── Unit: too_far_in_advance ────────────────────────────────────────────────

describe('evaluateBookingPolicy — too_far_in_advance', () => {
  const policy: BookingPolicy = { maxDurationMinutes: null, maxAdvanceDays: 30, minAdvanceMinutes: null };

  it('over the limit ⇒ violation carrying limit + actual', () => {
    const out = evaluateBookingPolicy(candidate(31 * DAY, 60), policy, [], 0);
    expect(kinds(out)).toEqual(['too_far_in_advance']);
    expect(out[0]).toEqual({
      kind: 'too_far_in_advance',
      resourceId: RID,
      limitDays: 30,
      actualDays: 31,
    });
  });

  it('exactly at the limit ⇒ OK (strict >)', () => {
    expect(evaluateBookingPolicy(candidate(30 * DAY, 60), policy, [], 0)).toEqual([]);
  });

  it('under the limit ⇒ OK', () => {
    expect(evaluateBookingPolicy(candidate(10 * DAY, 60), policy, [], 0)).toEqual([]);
  });
});

// ─── Unit: insufficient_lead_time ────────────────────────────────────────────

describe('evaluateBookingPolicy — insufficient_lead_time', () => {
  const policy: BookingPolicy = { maxDurationMinutes: null, maxAdvanceDays: null, minAdvanceMinutes: 60 };

  it('under the required lead ⇒ violation carrying required + actual', () => {
    const out = evaluateBookingPolicy(candidate(30 * MIN, 60), policy, [], 0);
    expect(kinds(out)).toEqual(['insufficient_lead_time']);
    expect(out[0]).toEqual({
      kind: 'insufficient_lead_time',
      resourceId: RID,
      requiredMinutes: 60,
      actualMinutes: 30,
    });
  });

  it('exactly at the required lead ⇒ OK (strict <)', () => {
    expect(evaluateBookingPolicy(candidate(60 * MIN, 60), policy, [], 0)).toEqual([]);
  });

  it('more than the required lead ⇒ OK', () => {
    expect(evaluateBookingPolicy(candidate(120 * MIN, 60), policy, [], 0)).toEqual([]);
  });

  it('start in the past ⇒ violation (negative actual lead)', () => {
    const out = evaluateBookingPolicy(candidate(-10 * MIN, 60), policy, [], 0);
    expect(kinds(out)).toEqual(['insufficient_lead_time']);
    expect(out[0]).toMatchObject({ actualMinutes: -10 });
  });
});

// ─── Unit: blackout_overlap ──────────────────────────────────────────────────

describe('evaluateBookingPolicy — blackout_overlap', () => {
  it('adjacency (candidate.end === blackout.start) ⇒ no violation', () => {
    expect(
      evaluateBookingPolicy(candidate(0, 60), null, [{ start: 60 * MIN, end: 120 * MIN }], 0),
    ).toEqual([]);
  });

  it('adjacency (blackout.end === candidate.start) ⇒ no violation', () => {
    const cand = { resourceId: RID, start: 60 * MIN, end: 120 * MIN };
    expect(evaluateBookingPolicy(cand, null, [{ start: 0, end: 60 * MIN }], 0)).toEqual([]);
  });

  it('multiple overlapping blackouts ⇒ one violation each, in input order', () => {
    const cand = { resourceId: RID, start: 0, end: 1000 * MIN };
    const blackouts: BlackoutWindow[] = [
      { start: 10 * MIN, end: 20 * MIN },
      { start: 5000 * MIN, end: 6000 * MIN }, // disjoint
      { start: 30 * MIN, end: 40 * MIN },
    ];
    const out = evaluateBookingPolicy(cand, null, blackouts, 0);
    expect(out).toEqual([
      { kind: 'blackout_overlap', resourceId: RID, blackoutStart: 10 * MIN, blackoutEnd: 20 * MIN },
      { kind: 'blackout_overlap', resourceId: RID, blackoutStart: 30 * MIN, blackoutEnd: 40 * MIN },
    ]);
  });
});

// ─── Unit: composition / no short-circuit / determinism ──────────────────────

describe('evaluateBookingPolicy — composition', () => {
  it('all rules at once ⇒ all violations in rule order (no short-circuit)', () => {
    const policy: BookingPolicy = {
      maxDurationMinutes: 60,
      maxAdvanceDays: 1,
      minAdvanceMinutes: 10000, // huge floor ⇒ lead is insufficient
    };
    // start far in the future (too far in advance) AND duration too long AND
    // lead < floor is impossible simultaneously with "too far"... so craft now
    // so that start-now is large (too far) but minAdvance floor is even larger.
    const now = 0;
    const start = 5 * DAY; // 7200 min ahead
    const cand = { resourceId: RID, start, end: start + 120 * MIN }; // 120 > 60
    const blackouts: BlackoutWindow[] = [{ start: start + 10 * MIN, end: start + 20 * MIN }];
    const out = evaluateBookingPolicy(cand, policy, blackouts, now);
    expect(kinds(out)).toEqual([
      'max_duration_exceeded',
      'too_far_in_advance',
      'insufficient_lead_time',
      'blackout_overlap',
    ]);
  });

  it('now determinism: same inputs + same now ⇒ identical output', () => {
    const policy: BookingPolicy = { maxDurationMinutes: 120, maxAdvanceDays: 30, minAdvanceMinutes: 60 };
    const cand = candidate(5 * DAY, 90);
    const a = evaluateBookingPolicy(cand, policy, [], 1234);
    const b = evaluateBookingPolicy(cand, policy, [], 1234);
    expect(a).toEqual(b);
  });

  it('now affects advance/lead but not duration/blackout', () => {
    const policy: BookingPolicy = { maxDurationMinutes: null, maxAdvanceDays: 1, minAdvanceMinutes: 60 };
    const cand = candidate(2 * DAY, 60);
    // now = 0: 2 days ahead > 1 day ⇒ too_far; lead 2880min >= 60 ⇒ ok
    expect(kinds(evaluateBookingPolicy(cand, policy, [], 0))).toEqual(['too_far_in_advance']);
    // now = 2*DAY: lead 0 < 60 ⇒ insufficient; 0 <= 1 day ⇒ not too far
    expect(kinds(evaluateBookingPolicy(cand, policy, [], 2 * DAY))).toEqual(['insufficient_lead_time']);
  });
});

// ─── Property generators ─────────────────────────────────────────────────────

const epoch = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 });

const wellFormedBlackout = fc
  .record({ start: epoch, len: fc.integer({ min: 1, max: 1_000_000 }) })
  .map(({ start, len }) => ({ start, end: start + len }));

const wellFormedCandidate = fc
  .record({ start: epoch, len: fc.integer({ min: 1, max: 1_000_000 }) })
  .map(({ start, len }) => ({ resourceId: RID, start, end: start + len }));

const arbPolicy: fc.Arbitrary<BookingPolicy> = fc.record({
  maxDurationMinutes: fc.option(fc.integer({ min: 1, max: 10_000 }), { nil: null }),
  maxAdvanceDays: fc.option(fc.integer({ min: 0, max: 365 }), { nil: null }),
  minAdvanceMinutes: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: null }),
});

// ─── PB-1: no-policy ⇒ only blackout_overlap ─────────────────────────────────

describe('PB-1: null policy yields only blackout_overlap violations', () => {
  it('never emits a policy-rule violation when policy is null', () => {
    fc.assert(
      fc.property(
        wellFormedCandidate,
        fc.array(wellFormedBlackout, { maxLength: 12 }),
        epoch,
        (cand, blackouts, now) => {
          const out = evaluateBookingPolicy(cand, null, blackouts, now);
          for (const v of out) expect(v.kind).toBe('blackout_overlap');
        },
      ),
    );
  });
});

// ─── PB-2: order-independence of blackouts (violation SET stable) ────────────

describe('PB-2: permuting blackouts yields the same violation set', () => {
  it('violation set is invariant under blackout permutation', () => {
    fc.assert(
      fc.property(
        wellFormedCandidate,
        fc.option(arbPolicy, { nil: null }),
        fc.array(wellFormedBlackout, { maxLength: 10 }),
        epoch,
        (cand, policy, blackouts, now) => {
          const reversed = [...blackouts].reverse();
          const a = evaluateBookingPolicy(cand, policy, blackouts, now);
          const b = evaluateBookingPolicy(cand, policy, reversed, now);
          // Compare as multisets of stable-key strings (order may differ).
          const key = (v: PolicyViolation) => JSON.stringify(v);
          expect(a.map(key).sort()).toEqual(b.map(key).sort());
        },
      ),
    );
  });
});

// ─── PB-3: blackout adjacency is never a violation ───────────────────────────

describe('PB-3: blackout adjacency is never a violation', () => {
  it('a blackout placed exactly before/after the candidate never overlaps', () => {
    fc.assert(
      fc.property(
        wellFormedCandidate,
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.boolean(),
        (cand, gap, len, after) => {
          // after: blackout starts at candidate.end + gap (gap===0 ⇒ adjacent).
          // before: blackout ends at candidate.start - gap (gap===0 ⇒ adjacent).
          const b: BlackoutWindow = after
            ? { start: cand.end + gap, end: cand.end + gap + len }
            : { start: cand.start - gap - len, end: cand.start - gap };
          const out = evaluateBookingPolicy(cand, null, [b], 0);
          // Only adjacency/disjointness here ⇒ no blackout_overlap at all.
          expect(out).toEqual([]);
        },
      ),
    );
  });
});

// ─── PB-4: blackout_overlap ⟺ intervalsOverlap ───────────────────────────────

describe('PB-4: blackout_overlap iff intervalsOverlap', () => {
  it('a blackout_overlap is emitted exactly when intervalsOverlap is true', () => {
    fc.assert(
      fc.property(
        wellFormedCandidate,
        fc.array(wellFormedBlackout, { maxLength: 12 }),
        (cand, blackouts) => {
          const out = evaluateBookingPolicy(cand, null, blackouts, 0);
          const emitted = out.filter((v) => v.kind === 'blackout_overlap').length;
          const expected = blackouts.filter((b) =>
            intervalsOverlap(cand.start, cand.end, b.start, b.end),
          ).length;
          expect(emitted).toBe(expected);
        },
      ),
    );
  });
});

// ─── PB-5: duration monotonicity (boundary flips exactly once) ───────────────

describe('PB-5: max-duration boundary flips exactly once as duration grows', () => {
  it('violation iff actual minutes strictly exceed the limit', () => {
    fc.assert(
      fc.property(
        epoch,
        fc.integer({ min: 1, max: 5000 }), // limit minutes
        fc.integer({ min: 0, max: 5000 }), // actual minutes
        (start, limit, actual) => {
          const policy: BookingPolicy = {
            maxDurationMinutes: limit,
            maxAdvanceDays: null,
            minAdvanceMinutes: null,
          };
          const cand = { resourceId: RID, start, end: start + actual * MIN };
          const out = evaluateBookingPolicy(cand, policy, [], 0);
          const violated = out.some((v) => v.kind === 'max_duration_exceeded');
          expect(violated).toBe(actual > limit);
        },
      ),
    );
  });
});

// ─── PB-7: monotone-in-now for advance & lead (each flips once) ──────────────

describe('PB-7: advance & lead are monotone in now, each flips exactly once', () => {
  it('too_far_in_advance iff start-now strictly exceeds the day budget', () => {
    fc.assert(
      fc.property(
        epoch, // start
        epoch, // now
        fc.integer({ min: 0, max: 365 }), // limit days
        (start, now, days) => {
          const policy: BookingPolicy = {
            maxDurationMinutes: null,
            maxAdvanceDays: days,
            minAdvanceMinutes: null,
          };
          const cand = { resourceId: RID, start, end: start + MIN };
          const out = evaluateBookingPolicy(cand, policy, [], now);
          const violated = out.some((v) => v.kind === 'too_far_in_advance');
          expect(violated).toBe(start - now > days * DAY);
        },
      ),
    );
  });

  it('insufficient_lead_time iff start-now strictly below the minute floor', () => {
    fc.assert(
      fc.property(
        epoch, // start
        epoch, // now
        fc.integer({ min: 0, max: 100_000 }), // floor minutes
        (start, now, minutes) => {
          const policy: BookingPolicy = {
            maxDurationMinutes: null,
            maxAdvanceDays: null,
            minAdvanceMinutes: minutes,
          };
          const cand = { resourceId: RID, start, end: start + MIN };
          const out = evaluateBookingPolicy(cand, policy, [], now);
          const violated = out.some((v) => v.kind === 'insufficient_lead_time');
          expect(violated).toBe(start - now < minutes * MIN);
        },
      ),
    );
  });
});
