/**
 * ar-aging.test.ts — unit + property tests for the pure AR-aging bucketer
 * (@aeroops/core). PROPERTY-BASED tests — money-math hard guardrail per
 * CLAUDE.md.
 *
 * WHAT WE PROVE:
 *   Unit targets:
 *     - boundary days (0, 1, 30, 31, 60, 61, 90, 91) classify into the
 *       documented bucket.
 *     - a future-dated referenceDate (negative age) clamps to 'current', never throws.
 *     - non-positive / non-finite / non-integer balanceCents sanitizes to 0.
 *     - invalid Date inputs never throw; ageDays clamps to 0.
 *
 *   Properties (fast-check):
 *     P1  Bucket-sum invariant: the 5 buckets of aggregateAging sum to totalCents,
 *         for ANY array of items (including the empty array).
 *     P2  Monotonic aging: for any two non-negative ageDays a <= b,
 *         rank(classifyAgingBucket(a)) <= rank(classifyAgingBucket(b)).
 *     P3  Integer closure: bucketAgingItem / aggregateAging always return
 *         safe, non-negative integers.
 *     P4  Never throws: arbitrary (including adversarial: NaN, Infinity,
 *         negative, fractional, invalid-date) inputs never throw.
 *     P5  Determinism: same input twice ⇒ same output (pure).
 *     P6  Single-item identity: bucketAgingItem(item).{bucket} === sanitized
 *         balanceCents, all other buckets 0.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ageDaysBetween,
  classifyAgingBucket,
  bucketAgingItem,
  sumAgingBuckets,
  aggregateAging,
  emptyAgingBuckets,
} from '../billing/ar-aging.js';
import type { AgingItem, AgingBucketKey } from '../billing/ar-aging.js';

const BUCKET_RANK: Record<AgingBucketKey, number> = {
  current: 0,
  d30: 1,
  d60: 2,
  d90: 3,
  d90plus: 4,
};

const ASOF = new Date('2026-07-01T00:00:00.000Z');

function daysBefore(n: number): Date {
  return new Date(ASOF.getTime() - n * 24 * 60 * 60 * 1000);
}

// ─── Generators ───────────────────────────────────────────────────────────────

const posCents = fc.integer({ min: 1, max: 10_000_000 });
const ageDaysGen = fc.integer({ min: 0, max: 5000 });

const agingItemGen: fc.Arbitrary<AgingItem> = fc.record({
  balanceCents: posCents,
  asOf: fc.constant(ASOF),
  referenceDate: ageDaysGen.map((d) => daysBefore(d)),
});

const agingItemsGen = fc.array(agingItemGen, { minLength: 0, maxLength: 100 });

// ─── Unit: boundary days ──────────────────────────────────────────────────────

describe('classifyAgingBucket — boundary days', () => {
  const cases: Array<[number, AgingBucketKey]> = [
    [0, 'current'],
    [1, 'd30'],
    [30, 'd30'],
    [31, 'd60'],
    [60, 'd60'],
    [61, 'd90'],
    [90, 'd90'],
    [91, 'd90plus'],
  ];
  for (const [days, expected] of cases) {
    it(`ageDays=${days} ⇒ '${expected}'`, () => {
      expect(classifyAgingBucket(days)).toBe(expected);
    });
  }

  it('negative ageDays ⇒ current (clamped, never throws)', () => {
    expect(classifyAgingBucket(-5)).toBe('current');
  });

  it('NaN ageDays ⇒ current (sanitized)', () => {
    expect(classifyAgingBucket(NaN)).toBe('current');
  });
});

// ─── Unit: ageDaysBetween ─────────────────────────────────────────────────────

describe('ageDaysBetween', () => {
  it('same instant ⇒ 0', () => {
    expect(ageDaysBetween(ASOF, ASOF)).toBe(0);
  });

  it('30 days before asOf ⇒ 30', () => {
    expect(ageDaysBetween(ASOF, daysBefore(30))).toBe(30);
  });

  it('a future-dated referenceDate (after asOf) ⇒ 0, never negative', () => {
    const future = new Date(ASOF.getTime() + 10 * 24 * 60 * 60 * 1000);
    expect(ageDaysBetween(ASOF, future)).toBe(0);
  });

  it('invalid Date (NaN time) on either side ⇒ 0, never throws', () => {
    const invalid = new Date('not-a-date');
    expect(ageDaysBetween(ASOF, invalid)).toBe(0);
    expect(ageDaysBetween(invalid, ASOF)).toBe(0);
    expect(ageDaysBetween(invalid, invalid)).toBe(0);
  });

  it('partial-day remainders floor down (23h59m ⇒ 0 full days)', () => {
    const almostADayAgo = new Date(ASOF.getTime() - (24 * 60 * 60 * 1000 - 60_000));
    expect(ageDaysBetween(ASOF, almostADayAgo)).toBe(0);
  });
});

// ─── Unit: sanitization (never throws, credit/zero balance zeroed) ───────────

describe('bucketAgingItem — sanitization', () => {
  it('zero balanceCents ⇒ all buckets 0', () => {
    const r = bucketAgingItem({ balanceCents: 0, asOf: ASOF, referenceDate: daysBefore(45) });
    expect(r).toMatchObject({ current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0, balanceCents: 0 });
  });

  it('negative balanceCents (credit balance) ⇒ sanitized to 0, never throws', () => {
    const r = bucketAgingItem({ balanceCents: -5000, asOf: ASOF, referenceDate: daysBefore(45) });
    expect(r.balanceCents).toBe(0);
    expect(r.current + r.d30 + r.d60 + r.d90 + r.d90plus).toBe(0);
  });

  it('non-integer balanceCents ⇒ sanitized to 0, never throws', () => {
    const r = bucketAgingItem({ balanceCents: 12.5, asOf: ASOF, referenceDate: daysBefore(45) });
    expect(r.balanceCents).toBe(0);
  });

  it('NaN/Infinity balanceCents ⇒ sanitized to 0, never throws', () => {
    expect(bucketAgingItem({ balanceCents: NaN, asOf: ASOF, referenceDate: daysBefore(45) }).balanceCents).toBe(0);
    expect(bucketAgingItem({ balanceCents: Infinity, asOf: ASOF, referenceDate: daysBefore(45) }).balanceCents).toBe(0);
  });

  it('a positive balance 45 days old ⇒ entirely in d60, other buckets 0', () => {
    const r = bucketAgingItem({ balanceCents: 12345, asOf: ASOF, referenceDate: daysBefore(45) });
    expect(r.bucket).toBe('d60');
    expect(r.d60).toBe(12345);
    expect(r.current + r.d30 + r.d90 + r.d90plus).toBe(0);
  });
});

// ─── Unit: emptyAgingBuckets / sumAgingBuckets ────────────────────────────────

describe('emptyAgingBuckets / sumAgingBuckets', () => {
  it('emptyAgingBuckets() is all zero', () => {
    expect(emptyAgingBuckets()).toEqual({ current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 });
  });

  it('sumAgingBuckets([]) is all zero', () => {
    expect(sumAgingBuckets([])).toEqual({ current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 });
  });

  it('sumAgingBuckets sums element-wise', () => {
    const a = { current: 100, d30: 0, d60: 0, d90: 0, d90plus: 0 };
    const b = { current: 0, d30: 200, d60: 0, d90: 0, d90plus: 0 };
    expect(sumAgingBuckets([a, b])).toEqual({ current: 100, d30: 200, d60: 0, d90: 0, d90plus: 0 });
  });
});

// ─── aggregateAging — hand-computed sample (handoff verification) ────────────

describe('aggregateAging — hand-computed sample', () => {
  it('3 members: $100 current, $250 at 45d (d60), $500 at 120d (d90plus)', () => {
    const items: AgingItem[] = [
      { balanceCents: 10000, asOf: ASOF, referenceDate: daysBefore(0) },
      { balanceCents: 25000, asOf: ASOF, referenceDate: daysBefore(45) },
      { balanceCents: 50000, asOf: ASOF, referenceDate: daysBefore(120) },
    ];
    const result = aggregateAging(items);
    expect(result).toEqual({
      buckets: { current: 10000, d30: 0, d60: 25000, d90: 0, d90plus: 50000 },
      totalCents: 85000,
    });
  });

  it('empty input ⇒ all-zero buckets, total 0', () => {
    expect(aggregateAging([])).toEqual({
      buckets: emptyAgingBuckets(),
      totalCents: 0,
    });
  });
});

// ─── P1 Bucket-sum invariant ───────────────────────────────────────────────────

describe('P1 — bucket-sum invariant: the 5 buckets always sum to totalCents', () => {
  it('holds for arbitrary item arrays', () => {
    fc.assert(
      fc.property(agingItemsGen, (items) => {
        const { buckets, totalCents } = aggregateAging(items);
        const sum = buckets.current + buckets.d30 + buckets.d60 + buckets.d90 + buckets.d90plus;
        expect(sum).toBe(totalCents);
      }),
    );
  });
});

// ─── P2 Monotonic aging ────────────────────────────────────────────────────────

describe('P2 — monotonic aging: bigger ageDays never buckets to an earlier tier', () => {
  it('for any 0 <= a <= b, rank(classify(a)) <= rank(classify(b))', () => {
    fc.assert(
      fc.property(ageDaysGen, ageDaysGen, (x, y) => {
        const a = Math.min(x, y);
        const b = Math.max(x, y);
        const rankA = BUCKET_RANK[classifyAgingBucket(a)];
        const rankB = BUCKET_RANK[classifyAgingBucket(b)];
        expect(rankA).toBeLessThanOrEqual(rankB);
      }),
    );
  });
});

// ─── P3 Integer closure ─────────────────────────────────────────────────────────

describe('P3 — integer closure: results are always safe non-negative integers', () => {
  it('bucketAgingItem fields are all safe non-negative integers', () => {
    fc.assert(
      fc.property(agingItemGen, (item) => {
        const r = bucketAgingItem(item);
        for (const v of [r.current, r.d30, r.d60, r.d90, r.d90plus, r.ageDays, r.balanceCents]) {
          expect(Number.isSafeInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it('aggregateAging totals are always safe non-negative integers', () => {
    fc.assert(
      fc.property(agingItemsGen, (items) => {
        const { buckets, totalCents } = aggregateAging(items);
        for (const v of [buckets.current, buckets.d30, buckets.d60, buckets.d90, buckets.d90plus, totalCents]) {
          expect(Number.isSafeInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });
});

// ─── P4 Never throws (adversarial fuzzing) ────────────────────────────────────

describe('P4 — never throws, even on adversarial input', () => {
  const adversarialCents = fc.oneof(
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.constant(NaN),
    fc.constant(Infinity),
    fc.constant(-Infinity),
    fc.double({ noNaN: false }),
  );
  const adversarialDate = fc.oneof(
    fc.date(),
    fc.constant(new Date('not-a-date')),
  );

  it('bucketAgingItem never throws for arbitrary balanceCents/dates', () => {
    fc.assert(
      fc.property(adversarialCents, adversarialDate, adversarialDate, (balanceCents, asOf, referenceDate) => {
        expect(() => bucketAgingItem({ balanceCents, asOf, referenceDate })).not.toThrow();
      }),
    );
  });

  it('ageDaysBetween never throws for arbitrary dates', () => {
    fc.assert(
      fc.property(adversarialDate, adversarialDate, (asOf, referenceDate) => {
        expect(() => ageDaysBetween(asOf, referenceDate)).not.toThrow();
      }),
    );
  });
});

// ─── P5 Determinism ─────────────────────────────────────────────────────────────

describe('P5 — determinism: same input twice ⇒ same output', () => {
  it('bucketAgingItem is pure', () => {
    fc.assert(
      fc.property(agingItemGen, (item) => {
        expect(bucketAgingItem(item)).toEqual(bucketAgingItem(item));
      }),
    );
  });

  it('aggregateAging is pure', () => {
    fc.assert(
      fc.property(agingItemsGen, (items) => {
        expect(aggregateAging(items)).toEqual(aggregateAging(items));
      }),
    );
  });
});

// ─── P6 Single-item identity ────────────────────────────────────────────────────

describe('P6 — single-item identity: whole sanitized balance lands in exactly one bucket', () => {
  it('holds for arbitrary items', () => {
    fc.assert(
      fc.property(agingItemGen, (item) => {
        const r = bucketAgingItem(item);
        const buckets: Record<AgingBucketKey, number> = {
          current: r.current, d30: r.d30, d60: r.d60, d90: r.d90, d90plus: r.d90plus,
        };
        for (const key of Object.keys(buckets) as AgingBucketKey[]) {
          if (key === r.bucket) {
            expect(buckets[key]).toBe(r.balanceCents);
          } else {
            expect(buckets[key]).toBe(0);
          }
        }
      }),
    );
  });
});
