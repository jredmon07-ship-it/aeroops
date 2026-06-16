/**
 * overlap.test.ts — unit + property tests for the pure conflict predicate.
 *
 * This is where the SCHED-1 conflict-detection PROPERTY tests live (ADR-0004
 * invariant 5). Half-open `[start, end)` semantics: adjacency is NOT a conflict.
 *
 * COVERAGE:
 *   Unit:
 *     - clearly overlapping → true
 *     - disjoint → false
 *     - half-open touching (aEnd===bStart, bEnd===aStart) → false
 *     - containment (A inside B, both directions) → true
 *     - identical windows → true
 *     - degenerate (empty) intervals never overlap
 *   Property (fast-check):
 *     - symmetry: intervalsOverlap(a,b) === intervalsOverlap(b,a)
 *     - disjoint (aEnd <= bStart) ⇒ false  (covers touching boundary)
 *     - overlap ⇒ ∃ shared instant t with max(starts) <= t < min(ends)
 *     - findConflicts returns exactly the colliding subset; [] when all disjoint
 *     - findConflicts ⊆ candidate.resourceIds, distinct, order-preserving
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { intervalsOverlap, findConflicts } from '../overlap.js';

// ─── Unit: intervalsOverlap ──────────────────────────────────────────────────

describe('intervalsOverlap — unit', () => {
  it('clearly overlapping intervals → true', () => {
    // A [0,10) and B [5,15) share [5,10)
    expect(intervalsOverlap(0, 10, 5, 15)).toBe(true);
  });

  it('disjoint intervals → false', () => {
    // A [0,5) entirely before B [10,20)
    expect(intervalsOverlap(0, 5, 10, 20)).toBe(false);
    // and the reverse
    expect(intervalsOverlap(10, 20, 0, 5)).toBe(false);
  });

  it('half-open touching: aEnd === bStart → false (adjacency is not conflict)', () => {
    // A [0,10) ends exactly where B [10,20) begins — back-to-back, legal
    expect(intervalsOverlap(0, 10, 10, 20)).toBe(false);
  });

  it('half-open touching: bEnd === aStart → false (adjacency is not conflict)', () => {
    // B [0,10) ends exactly where A [10,20) begins
    expect(intervalsOverlap(10, 20, 0, 10)).toBe(false);
  });

  it('containment: A inside B → true', () => {
    expect(intervalsOverlap(5, 8, 0, 20)).toBe(true);
  });

  it('containment: B inside A → true', () => {
    expect(intervalsOverlap(0, 20, 5, 8)).toBe(true);
  });

  it('identical windows → true', () => {
    expect(intervalsOverlap(100, 200, 100, 200)).toBe(true);
  });

  it('overlap of exactly one instant width → true (A [0,2), B [1,3))', () => {
    expect(intervalsOverlap(0, 2, 1, 3)).toBe(true);
  });

  it('degenerate empty A (start === end) never overlaps', () => {
    expect(intervalsOverlap(5, 5, 0, 10)).toBe(false);
  });

  it('degenerate empty B (start === end) never overlaps', () => {
    expect(intervalsOverlap(0, 10, 5, 5)).toBe(false);
  });

  it('degenerate inverted interval (start > end) never overlaps', () => {
    expect(intervalsOverlap(10, 0, 0, 20)).toBe(false);
  });
});

// ─── Property: intervalsOverlap ──────────────────────────────────────────────

// A well-formed half-open interval [start, start+len) with len >= 1.
const wellFormedInterval = fc
  .record({
    start: fc.integer({ min: -1_000_000, max: 1_000_000 }),
    len: fc.integer({ min: 1, max: 100_000 }),
  })
  .map(({ start, len }) => ({ start, end: start + len }));

describe('intervalsOverlap — property', () => {
  it('symmetry: overlap(a,b) === overlap(b,a)', () => {
    fc.assert(
      fc.property(wellFormedInterval, wellFormedInterval, (a, b) => {
        expect(intervalsOverlap(a.start, a.end, b.start, b.end)).toBe(
          intervalsOverlap(b.start, b.end, a.start, a.end),
        );
      }),
    );
  });

  it('disjoint (aEnd <= bStart) ⇒ false — covers the touching boundary', () => {
    fc.assert(
      fc.property(
        wellFormedInterval,
        // gap >= 0 so that B starts at or after A ends (gap===0 is touching).
        fc.integer({ min: 0, max: 50_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (a, gap, bLen) => {
          const bStart = a.end + gap; // bStart >= aEnd
          const bEnd = bStart + bLen;
          expect(intervalsOverlap(a.start, a.end, bStart, bEnd)).toBe(false);
          // symmetric direction too
          expect(intervalsOverlap(bStart, bEnd, a.start, a.end)).toBe(false);
        },
      ),
    );
  });

  it('overlap ⇒ ∃ shared instant t with max(starts) <= t < min(ends)', () => {
    fc.assert(
      fc.property(wellFormedInterval, wellFormedInterval, (a, b) => {
        const overlaps = intervalsOverlap(a.start, a.end, b.start, b.end);
        const lo = Math.max(a.start, b.start);
        const hi = Math.min(a.end, b.end);
        // The half-open intersection [lo, hi) is non-empty iff lo < hi, and
        // when non-empty, t = lo is a shared instant.
        const hasSharedInstant = lo < hi;
        expect(overlaps).toBe(hasSharedInstant);
        if (overlaps) {
          const t = lo;
          expect(a.start <= t && t < a.end).toBe(true);
          expect(b.start <= t && t < b.end).toBe(true);
        }
      }),
    );
  });

  it('reflexive: a non-empty interval overlaps itself', () => {
    fc.assert(
      fc.property(wellFormedInterval, (a) => {
        expect(intervalsOverlap(a.start, a.end, a.start, a.end)).toBe(true);
      }),
    );
  });
});

// ─── Unit: findConflicts ─────────────────────────────────────────────────────

describe('findConflicts — unit', () => {
  it('returns [] when there are no existing bookings', () => {
    expect(findConflicts({ resourceIds: ['ac-1', 'cfi-1'], start: 0, end: 10 }, [])).toEqual([]);
  });

  it('returns [] when existing bookings are on other resources', () => {
    expect(
      findConflicts({ resourceIds: ['ac-1'], start: 0, end: 10 }, [
        { resourceId: 'ac-2', start: 0, end: 10 },
        { resourceId: 'cfi-9', start: 0, end: 10 },
      ]),
    ).toEqual([]);
  });

  it('returns [] when same resource but disjoint windows (adjacency)', () => {
    expect(
      findConflicts({ resourceIds: ['ac-1'], start: 10, end: 20 }, [
        { resourceId: 'ac-1', start: 0, end: 10 }, // touches, half-open ⇒ ok
      ]),
    ).toEqual([]);
  });

  it('returns the single colliding resource', () => {
    expect(
      findConflicts({ resourceIds: ['ac-1', 'cfi-1'], start: 5, end: 15 }, [
        { resourceId: 'ac-1', start: 0, end: 10 }, // overlaps
        { resourceId: 'cfi-1', start: 100, end: 110 }, // disjoint
      ]),
    ).toEqual(['ac-1']);
  });

  it('returns multiple colliding resources in candidate order', () => {
    expect(
      findConflicts({ resourceIds: ['ac-1', 'cfi-1'], start: 5, end: 15 }, [
        { resourceId: 'cfi-1', start: 0, end: 10 },
        { resourceId: 'ac-1', start: 12, end: 30 },
      ]),
    ).toEqual(['ac-1', 'cfi-1']);
  });

  it('de-duplicates: a resource colliding with several bookings appears once', () => {
    expect(
      findConflicts({ resourceIds: ['ac-1'], start: 0, end: 100 }, [
        { resourceId: 'ac-1', start: 0, end: 10 },
        { resourceId: 'ac-1', start: 20, end: 30 },
        { resourceId: 'ac-1', start: 40, end: 50 },
      ]),
    ).toEqual(['ac-1']);
  });

  it('de-duplicates: a duplicated candidate resourceId appears once', () => {
    expect(
      findConflicts({ resourceIds: ['ac-1', 'ac-1'], start: 0, end: 10 }, [
        { resourceId: 'ac-1', start: 5, end: 15 },
      ]),
    ).toEqual(['ac-1']);
  });

  it('cancelled rows are the callers responsibility — findConflicts sees only what it is given', () => {
    // The db/api layer filters status='booked' before calling. This documents
    // that findConflicts treats every supplied row as live.
    expect(
      findConflicts({ resourceIds: ['ac-1'], start: 0, end: 10 }, [
        { resourceId: 'ac-1', start: 5, end: 15 },
      ]),
    ).toEqual(['ac-1']);
  });
});

// ─── Property: findConflicts ─────────────────────────────────────────────────

const resourceId = fc.constantFrom('ac-1', 'ac-2', 'cfi-1', 'cfi-2', 'sim-1');

const existingBooking = fc.record({
  resourceId,
  ...{
    start: fc.integer({ min: -1_000_000, max: 1_000_000 }),
    len: fc.integer({ min: 1, max: 100_000 }),
  },
}).map(({ resourceId: rid, start, len }) => ({ resourceId: rid, start, end: start + len }));

describe('findConflicts — property', () => {
  it('result is always a subset of candidate.resourceIds, distinct', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(resourceId, { minLength: 0, maxLength: 5 }),
        wellFormedInterval,
        fc.array(existingBooking, { maxLength: 20 }),
        (resourceIds, win, existing) => {
          const out = findConflicts(
            { resourceIds, start: win.start, end: win.end },
            existing,
          );
          // subset
          for (const r of out) expect(resourceIds).toContain(r);
          // distinct
          expect(new Set(out).size).toBe(out.length);
        },
      ),
    );
  });

  it('matches the brute-force definition exactly (the colliding subset)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(resourceId, { minLength: 0, maxLength: 5 }),
        wellFormedInterval,
        fc.array(existingBooking, { maxLength: 20 }),
        (resourceIds, win, existing) => {
          const out = findConflicts(
            { resourceIds, start: win.start, end: win.end },
            existing,
          );

          // Brute-force expected set: a resourceId conflicts iff some existing
          // booking on that exact resource overlaps the candidate window.
          const expectedSet = new Set<string>();
          for (const r of resourceIds) {
            for (const b of existing) {
              if (
                b.resourceId === r &&
                intervalsOverlap(win.start, win.end, b.start, b.end)
              ) {
                expectedSet.add(r);
                break;
              }
            }
          }

          expect(new Set(out)).toEqual(expectedSet);

          // order-preserving: out follows first-appearance order in resourceIds
          const expectedOrdered = resourceIds.filter(
            (r, i) => expectedSet.has(r) && resourceIds.indexOf(r) === i,
          );
          expect(out).toEqual(expectedOrdered);
        },
      ),
    );
  });

  it('returns [] when every existing booking is disjoint from the window', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(resourceId, { minLength: 0, maxLength: 5 }),
        wellFormedInterval,
        fc.array(
          fc.record({ resourceId, gap: fc.integer({ min: 0, max: 50_000 }), len: fc.integer({ min: 1, max: 100_000 }) }),
          { maxLength: 20 },
        ),
        (resourceIds, win, raw) => {
          // Place every existing booking entirely after the candidate window
          // (bStart >= win.end ⇒ disjoint, including the touching boundary).
          const existing = raw.map(({ resourceId: rid, gap, len }) => {
            const start = win.end + gap;
            return { resourceId: rid, start, end: start + len };
          });
          expect(
            findConflicts({ resourceIds, start: win.start, end: win.end }, existing),
          ).toEqual([]);
        },
      ),
    );
  });

  it('an exact-window self-collision on a shared resource is always reported', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(resourceId, { minLength: 1, maxLength: 5 }),
        wellFormedInterval,
        (resourceIds, win) => {
          // One existing booking that exactly matches the window on the first
          // candidate resource — must always be a conflict. minLength:1 ⇒ defined.
          const target = resourceIds[0]!;
          const out = findConflicts(
            { resourceIds, start: win.start, end: win.end },
            [{ resourceId: target, start: win.start, end: win.end }],
          );
          expect(out).toEqual([target]);
        },
      ),
    );
  });
});
