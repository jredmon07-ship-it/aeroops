/**
 * block-summary-math.test.ts — unit + property tests for the pure block-time
 * (prepaid package) summary math (Slice B4 @aeroops/core). PROPERTY-BASED
 * tests (the HARD guardrail per CLAUDE.md: money math gets property tests).
 *
 * WHAT WE PROVE (aggregateBlockPurchases):
 *   Unit targets: empty ⇒ {0,0}; single/multiple purchases; canonical scenarios.
 *   Properties (fast-check):
 *     P1  Permutation invariance: order does not change the totals.
 *     P2  Integer closure: totalAmountCents is always a safe integer.
 *     P3  Append monotonicity: totalAmountCents/totalHours never decrease
 *         when a purchase is appended.
 *     P4  Zero-entry edge: aggregateBlockPurchases([]) === {0, 0}.
 *     P5  Determinism: same input twice ⇒ same output (pure).
 *     P6  Single-purchase identity: totals === that purchase's own values.
 *     P7  Sum-of-integers identity: totalAmountCents === the naive Σ.
 *     P8  Non-positive amountCents/hours ⇒ always throws RangeError.
 *
 * WHAT WE PROVE (computeEffectiveRateCentsPerHour):
 *   Unit targets: canonical division; rounding.
 *   Properties: always returns a non-negative safe integer for valid input;
 *     throws on non-positive priceCents/hours.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  aggregateBlockPurchases,
  computeEffectiveRateCentsPerHour,
} from '../billing/block-summary-math.js';
import type { BlockPurchaseAmount } from '../billing/block-summary-math.js';

// ─── Generators ───────────────────────────────────────────────────────────────

const posCents = fc.integer({ min: 1, max: 10_000_000 });
/** A realistic positive hours value, 1 decimal place, [0.1, 500.0]. */
const posHoursTenths = fc.integer({ min: 1, max: 5_000 }).map((tenths) => tenths / 10);

const purchaseGen: fc.Arbitrary<BlockPurchaseAmount> = fc.record({
  hours: posHoursTenths,
  amountCents: posCents,
});

const purchasesGen = fc.array(purchaseGen, { minLength: 0, maxLength: 200 });

// ─── Unit edges — aggregateBlockPurchases ──────────────────────────────────────

describe('aggregateBlockPurchases — unit edges', () => {
  it('empty array ⇒ {totalHours: 0, totalAmountCents: 0}', () => {
    expect(aggregateBlockPurchases([])).toEqual({ totalHours: 0, totalAmountCents: 0 });
  });

  it('single purchase ⇒ totals equal that purchase', () => {
    expect(aggregateBlockPurchases([{ hours: 10, amountCents: 150000 }])).toEqual({
      totalHours: 10,
      totalAmountCents: 150000,
    });
  });

  it('two purchases sum exactly (integer cents, exact tenths)', () => {
    const result = aggregateBlockPurchases([
      { hours: 10, amountCents: 150000 },
      { hours: 5.5, amountCents: 75000 },
    ]);
    expect(result).toEqual({ totalHours: 15.5, totalAmountCents: 225000 });
  });

  it('many fractional-hour purchases sum without float drift', () => {
    // 0.1 repeated 10 times must total EXACTLY 1.0, not 0.9999999999999999.
    const purchases: BlockPurchaseAmount[] = Array.from({ length: 10 }, () => ({
      hours: 0.1,
      amountCents: 100,
    }));
    const result = aggregateBlockPurchases(purchases);
    expect(result.totalHours).toBe(1);
    expect(result.totalAmountCents).toBe(1000);
  });
});

// ─── Error paths ────────────────────────────────────────────────────────────

describe('aggregateBlockPurchases — error paths', () => {
  it('zero amountCents ⇒ throws RangeError', () => {
    expect(() => aggregateBlockPurchases([{ hours: 1, amountCents: 0 }])).toThrow(RangeError);
  });

  it('negative amountCents ⇒ throws RangeError', () => {
    expect(() => aggregateBlockPurchases([{ hours: 1, amountCents: -5 }])).toThrow(RangeError);
  });

  it('non-integer amountCents ⇒ throws RangeError', () => {
    expect(() => aggregateBlockPurchases([{ hours: 1, amountCents: 10.5 }])).toThrow(RangeError);
  });

  it('zero hours ⇒ throws RangeError', () => {
    expect(() => aggregateBlockPurchases([{ hours: 0, amountCents: 100 }])).toThrow(RangeError);
  });

  it('negative hours ⇒ throws RangeError', () => {
    expect(() => aggregateBlockPurchases([{ hours: -1, amountCents: 100 }])).toThrow(RangeError);
  });

  it('NaN/Infinity hours or amountCents ⇒ throws RangeError', () => {
    expect(() => aggregateBlockPurchases([{ hours: NaN, amountCents: 100 }])).toThrow(RangeError);
    expect(() => aggregateBlockPurchases([{ hours: 1, amountCents: Infinity }])).toThrow(RangeError);
  });

  it('throws on the first invalid entry even if earlier entries were valid', () => {
    expect(() =>
      aggregateBlockPurchases([
        { hours: 1, amountCents: 100 },
        { hours: -1, amountCents: 100 },
      ]),
    ).toThrow(RangeError);
  });
});

// ─── P1 Permutation invariance ─────────────────────────────────────────────────

describe('P1 — Permutation invariance: order does not change the totals', () => {
  it('reversed purchases produce the same totals', () => {
    fc.assert(
      fc.property(purchasesGen, (purchases) => {
        const reversed = [...purchases].reverse();
        expect(aggregateBlockPurchases(reversed)).toEqual(aggregateBlockPurchases(purchases));
      }),
    );
  });
});

// ─── P2 Integer closure ─────────────────────────────────────────────────────────

describe('P2 — Integer closure: totalAmountCents is always a safe integer', () => {
  it('holds for any valid list of purchases', () => {
    fc.assert(
      fc.property(purchasesGen, (purchases) => {
        const result = aggregateBlockPurchases(purchases);
        expect(Number.isInteger(result.totalAmountCents)).toBe(true);
        expect(Number.isSafeInteger(result.totalAmountCents)).toBe(true);
        expect(result.totalAmountCents).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

// ─── P3 Append monotonicity ─────────────────────────────────────────────────────

describe('P3 — Append monotonicity: totals never decrease when a purchase is appended', () => {
  it('totalAmountCents and totalHours are both >= before appending', () => {
    fc.assert(
      fc.property(purchasesGen, purchaseGen, (purchases, extra) => {
        const before = aggregateBlockPurchases(purchases);
        const after = aggregateBlockPurchases([...purchases, extra]);
        expect(after.totalAmountCents).toBeGreaterThanOrEqual(before.totalAmountCents);
        expect(after.totalHours).toBeGreaterThanOrEqual(before.totalHours);
      }),
    );
  });
});

// ─── P4 Zero-entry edge ─────────────────────────────────────────────────────────

describe('P4 — Zero-entry edge', () => {
  it('aggregateBlockPurchases([]) === {0, 0}', () => {
    expect(aggregateBlockPurchases([])).toEqual({ totalHours: 0, totalAmountCents: 0 });
  });
});

// ─── P5 Determinism ─────────────────────────────────────────────────────────────

describe('P5 — Determinism: same input twice ⇒ same output (pure)', () => {
  it('holds for any valid list of purchases', () => {
    fc.assert(
      fc.property(purchasesGen, (purchases) => {
        expect(aggregateBlockPurchases(purchases)).toEqual(aggregateBlockPurchases(purchases));
      }),
    );
  });
});

// ─── P6 Single-purchase identity ────────────────────────────────────────────────

describe('P6 — Single-purchase identity', () => {
  it('totals equal that single purchase for any valid values', () => {
    fc.assert(
      fc.property(purchaseGen, (p) => {
        expect(aggregateBlockPurchases([p])).toEqual({ totalHours: p.hours, totalAmountCents: p.amountCents });
      }),
    );
  });
});

// ─── P7 Sum-of-integers identity ────────────────────────────────────────────────

describe('P7 — Sum-of-integers identity: totalAmountCents === naive Σ', () => {
  it('holds for any valid list of purchases', () => {
    fc.assert(
      fc.property(purchasesGen, (purchases) => {
        const naiveSum = purchases.reduce((acc, p) => acc + p.amountCents, 0);
        expect(aggregateBlockPurchases(purchases).totalAmountCents).toBe(naiveSum);
      }),
    );
  });
});

// ─── P8 Precondition: non-positive amountCents/hours ⇒ throws ──────────────────

describe('P8 — Non-positive amountCents or hours always throws RangeError', () => {
  it('zero or negative amountCents always throws', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 0 }), posHoursTenths, (amountCents, hours) => {
        expect(() => aggregateBlockPurchases([{ hours, amountCents }])).toThrow(RangeError);
      }),
    );
  });

  it('zero or negative hours always throws', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000, max: 0 }).map((n) => n / 10), posCents, (hours, amountCents) => {
        expect(() => aggregateBlockPurchases([{ hours, amountCents }])).toThrow(RangeError);
      }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// computeEffectiveRateCentsPerHour
// ════════════════════════════════════════════════════════════════════════════

describe('computeEffectiveRateCentsPerHour — unit edges', () => {
  it('$1500.00 / 10 hours = $150.00/hr = 15000 cents/hr', () => {
    expect(computeEffectiveRateCentsPerHour(150000, 10)).toBe(15000);
  });

  it('rounds to the nearest cent for a non-exact division', () => {
    // 10000 / 3 = 3333.33... → rounds to 3333
    expect(computeEffectiveRateCentsPerHour(10000, 3)).toBe(3333);
  });

  it('zero/negative priceCents ⇒ throws RangeError', () => {
    expect(() => computeEffectiveRateCentsPerHour(0, 10)).toThrow(RangeError);
    expect(() => computeEffectiveRateCentsPerHour(-100, 10)).toThrow(RangeError);
  });

  it('non-integer priceCents ⇒ throws RangeError', () => {
    expect(() => computeEffectiveRateCentsPerHour(100.5, 10)).toThrow(RangeError);
  });

  it('zero/negative hours ⇒ throws RangeError', () => {
    expect(() => computeEffectiveRateCentsPerHour(1000, 0)).toThrow(RangeError);
    expect(() => computeEffectiveRateCentsPerHour(1000, -5)).toThrow(RangeError);
  });
});

describe('computeEffectiveRateCentsPerHour — properties', () => {
  it('always returns a non-negative safe integer for valid input', () => {
    fc.assert(
      fc.property(posCents, posHoursTenths, (priceCents, hours) => {
        const result = computeEffectiveRateCentsPerHour(priceCents, hours);
        expect(Number.isSafeInteger(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});
