/**
 * invoice-math.test.ts — unit + property tests for the pure billing invoice math
 * (B1 @aeroops/core). This is where the BILLING-B1 PROPERTY tests live (the HARD
 * guardrail per CLAUDE.md: "money math gets PROPERTY-BASED tests").
 *
 * ROUNDING RULE (pin here): round-half-up via Math.floor(x + 0.5).
 *   applyRate(1.3, 12500) = floor(16250.0 + 0.5) = 16250 cents  ✓
 *   applyRate(0.5, 1)     = floor(0.5 + 0.5) = floor(1.0) = 1 cent ✓ (half rounds up)
 *   applyRate(0.3, 1)     = floor(0.3 + 0.5) = floor(0.8) = 0 cent ✓
 *
 * WHAT WE PROVE:
 *   Unit targets:
 *     - applyRate / computeLineTotal: zero hours, zero rate, canonical cases,
 *       round-half-up at .5 boundary, equivalence of the two entry points.
 *     - computeInvoiceTotals: empty, single, multi, ordering independence, zero-line.
 *     - applyPricingGroupDiscount: 0bps no-op, 10000bps full discount, midpoint.
 *     - Error paths: negative inputs, NaN, Infinity, non-integer lineTotalCents.
 *
 *   Properties (fast-check), ALL money as integer cents:
 *     P1  Non-negativity: non-negative inputs ⇒ result >= 0.
 *     P2  Integer result: applyRate / computeLineTotal always returns an integer.
 *     P3  Zero hours ⇒ 0 (for any rate).
 *     P4  Zero rate ⇒ 0 (for any hours).
 *     P5  Determinism: same input ⇒ same output (pure).
 *     P6  subtotalCents === Σ lineTotalCents (exact integer sum, no float drift).
 *     P7  Commutativity / ordering independence of computeInvoiceTotals.
 *     P8  totalCents === subtotalCents (B1 invariant).
 *     P9  Adding a zero-amount line does not change the subtotal.
 *     P10 Single-line invoice: subtotalCents === the one lineTotalCents.
 *     P11 Large values: no float overflow into imprecision (safe-integer domain).
 *     P12 applyPricingGroupDiscount result in [0, amountCents].
 *     P13 applyPricingGroupDiscount(n, 0) === n (0 bps = identity).
 *     P14 applyPricingGroupDiscount(n, 10000) === 0 (full discount).
 *     P15 applyRate / computeLineTotal are byte-for-byte equivalent.
 *     P16 Precondition: negative input ⇒ throws RangeError (applyRate).
 *     P17 computeInvoiceTotals: non-integer / negative lineTotalCents ⇒ throws.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  applyRate,
  computeLineTotal,
  computeInvoiceTotals,
  applyPricingGroupDiscount,
  computeCounterSaleLineTotal,
} from '../billing/invoice-math.js';
import type { InvoiceLine, InvoiceTotals } from '../billing/invoice-math.js';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Non-negative, finite decimal hours on the 0.1 grid (matching numeric(10,1)).
 * Generated as integer tenths in [0, 100_000] divided by 10: [0.0 .. 10000.0].
 */
const gridTenths = fc.integer({ min: 0, max: 100_000 });
const gridHours = gridTenths.map((t) => t / 10);

/** Non-negative, finite rate per hour in integer cents [0..1_000_000] ($0–$10,000/hr). */
const rateCents = fc.integer({ min: 0, max: 1_000_000 });

/** A realistic non-negative integer cent amount [0..10_000_000] ($0–$100,000). */
const intCents = fc.integer({ min: 0, max: 10_000_000 });

/** Basis points for discounts [0..10_000]. */
const bpsGen = fc.integer({ min: 0, max: 10_000 });

/** An array of non-negative integer line totals (0..10_000 items, each 0..100_000 cents). */
const lineItems = fc
  .array(fc.integer({ min: 0, max: 100_000 }), { minLength: 0, maxLength: 10_000 })
  .map((arr): InvoiceLine[] => arr.map((v) => ({ lineTotalCents: v })));

// ─── Unit edges — applyRate ───────────────────────────────────────────────────

describe('applyRate — unit edges', () => {
  it('zero hours, any rate ⇒ 0', () => {
    expect(applyRate(0, 0)).toBe(0);
    expect(applyRate(0, 12500)).toBe(0);
    expect(applyRate(0, 1_000_000)).toBe(0);
  });

  it('any hours, zero rate ⇒ 0', () => {
    expect(applyRate(1.3, 0)).toBe(0);
    expect(applyRate(100.0, 0)).toBe(0);
    expect(applyRate(0.1, 0)).toBe(0);
  });

  it('canonical case: applyRate(1.3, 12500) = 16250 cents', () => {
    // 1.3 × 12500 = 16250.0 → floor(16250.0 + 0.5) = floor(16250.5) = 16250
    expect(applyRate(1.3, 12500)).toBe(16250);
  });

  it('whole hours: applyRate(2, 12500) = 25000 cents', () => {
    expect(applyRate(2, 12500)).toBe(25000);
  });

  it('1-cent rate: applyRate(1.0, 1) = 1', () => {
    expect(applyRate(1.0, 1)).toBe(1);
  });

  it('round-half-up at .5: applyRate(0.5, 1) = 1 (half rounds UP)', () => {
    // 0.5 × 1 = 0.5 → floor(0.5 + 0.5) = floor(1.0) = 1
    expect(applyRate(0.5, 1)).toBe(1);
  });

  it('round-down below .5: applyRate(0.3, 1) = 0', () => {
    // 0.3 × 1 = 0.3 → floor(0.3 + 0.5) = floor(0.8) = 0
    expect(applyRate(0.3, 1)).toBe(0);
  });

  it('round-half-up: applyRate(1.5, 1) = 2', () => {
    // 1.5 × 1 = 1.5 → floor(1.5 + 0.5) = floor(2.0) = 2
    expect(applyRate(1.5, 1)).toBe(2);
  });

  it('tiny fraction below half: applyRate(0.4, 1) = 0', () => {
    expect(applyRate(0.4, 1)).toBe(0);
  });

  it('large realistic case: applyRate(10000.0, 1_000_000) = 10_000_000_000', () => {
    // 10000 × 1_000_000 = 10_000_000_000 (10B cents = $100M) — within JS safe integer
    expect(applyRate(10000.0, 1_000_000)).toBe(10_000_000_000);
    expect(Number.isSafeInteger(applyRate(10000.0, 1_000_000))).toBe(true);
  });

  it('result is always an integer', () => {
    expect(Number.isInteger(applyRate(1.3, 12500))).toBe(true);
    expect(Number.isInteger(applyRate(0.1, 3))).toBe(true);
    expect(Number.isInteger(applyRate(0.7, 7))).toBe(true);
  });

  it('never returns -0', () => {
    expect(Object.is(applyRate(0, 0), -0)).toBe(false);
    expect(Object.is(applyRate(0, 12500), -0)).toBe(false);
  });
});

// ─── Unit edges — applyRate error paths ───────────────────────────────────────

describe('applyRate — error paths', () => {
  it('negative hours ⇒ throws RangeError', () => {
    expect(() => applyRate(-1, 12500)).toThrow(RangeError);
    expect(() => applyRate(-0.1, 0)).toThrow(RangeError);
  });

  it('negative rate ⇒ throws RangeError', () => {
    expect(() => applyRate(1, -1)).toThrow(RangeError);
    expect(() => applyRate(0, -100)).toThrow(RangeError);
  });

  it('NaN hours ⇒ throws RangeError', () => {
    expect(() => applyRate(NaN, 100)).toThrow(RangeError);
  });

  it('NaN rate ⇒ throws RangeError', () => {
    expect(() => applyRate(1, NaN)).toThrow(RangeError);
  });

  it('Infinity hours ⇒ throws RangeError', () => {
    expect(() => applyRate(Infinity, 100)).toThrow(RangeError);
  });

  it('Infinity rate ⇒ throws RangeError', () => {
    expect(() => applyRate(1, Infinity)).toThrow(RangeError);
  });

  it('-Infinity ⇒ throws RangeError', () => {
    expect(() => applyRate(-Infinity, 100)).toThrow(RangeError);
    expect(() => applyRate(1, -Infinity)).toThrow(RangeError);
  });

  it('fractional ratePerHourCents ⇒ throws RangeError (caller bug guard)', () => {
    // Rates MUST be integer cents. A fractional rate is a caller bug and must
    // NOT be silently rounded in audit-grade billing records.
    expect(() => applyRate(1.0, 12.5)).toThrow(RangeError);
    expect(() => applyRate(1.0, 100.1)).toThrow(RangeError);
    expect(() => applyRate(0,   0.5)).toThrow(RangeError);
  });
});

// ─── computeLineTotal — alias equivalence ─────────────────────────────────────

describe('computeLineTotal — alias for applyRate', () => {
  it('computeLineTotal(1.3, 12500) === applyRate(1.3, 12500)', () => {
    expect(computeLineTotal(1.3, 12500)).toBe(applyRate(1.3, 12500));
  });

  it('computeLineTotal(0, 0) === 0', () => {
    expect(computeLineTotal(0, 0)).toBe(0);
  });

  it('computeLineTotal propagates errors identically', () => {
    expect(() => computeLineTotal(-1, 100)).toThrow(RangeError);
    expect(() => computeLineTotal(NaN, 100)).toThrow(RangeError);
  });
});

// ─── Unit edges — computeInvoiceTotals ────────────────────────────────────────

describe('computeInvoiceTotals — unit edges', () => {
  it('empty array ⇒ { subtotalCents: 0, totalCents: 0 }', () => {
    expect(computeInvoiceTotals([])).toEqual({ subtotalCents: 0, totalCents: 0 });
  });

  it('single line: subtotal = that line total', () => {
    expect(computeInvoiceTotals([{ lineTotalCents: 16250 }])).toEqual({
      subtotalCents: 16250,
      totalCents: 16250,
    });
  });

  it('single zero-amount line ⇒ subtotal 0', () => {
    expect(computeInvoiceTotals([{ lineTotalCents: 0 }])).toEqual({
      subtotalCents: 0,
      totalCents: 0,
    });
  });

  it('multiple lines: exact integer sum', () => {
    // 16250 + 12500 + 5000 = 33750
    const lines: InvoiceLine[] = [
      { lineTotalCents: 16250 },
      { lineTotalCents: 12500 },
      { lineTotalCents: 5000 },
    ];
    expect(computeInvoiceTotals(lines)).toEqual({
      subtotalCents: 33750,
      totalCents: 33750,
    });
  });

  it('B1 invariant: totalCents === subtotalCents', () => {
    const result = computeInvoiceTotals([{ lineTotalCents: 999 }, { lineTotalCents: 1 }]);
    expect(result.totalCents).toBe(result.subtotalCents);
  });

  it('ordering independence: [100, 200] same as [200, 100]', () => {
    const r1 = computeInvoiceTotals([{ lineTotalCents: 100 }, { lineTotalCents: 200 }]);
    const r2 = computeInvoiceTotals([{ lineTotalCents: 200 }, { lineTotalCents: 100 }]);
    expect(r1).toEqual(r2);
  });

  it('adding a zero-amount line does not change the subtotal', () => {
    const base = computeInvoiceTotals([{ lineTotalCents: 5000 }]);
    const withZero = computeInvoiceTotals([{ lineTotalCents: 5000 }, { lineTotalCents: 0 }]);
    expect(withZero.subtotalCents).toBe(base.subtotalCents);
  });

  it('returns a plain object with exactly subtotalCents + totalCents keys', () => {
    const result = computeInvoiceTotals([{ lineTotalCents: 100 }]);
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(['subtotalCents', 'totalCents']);
  });
});

// ─── Unit edges — computeInvoiceTotals error paths ────────────────────────────

describe('computeInvoiceTotals — error paths', () => {
  it('negative lineTotalCents ⇒ throws RangeError', () => {
    expect(() => computeInvoiceTotals([{ lineTotalCents: -1 }])).toThrow(RangeError);
  });

  it('non-integer lineTotalCents ⇒ throws RangeError', () => {
    expect(() => computeInvoiceTotals([{ lineTotalCents: 1.5 }])).toThrow(RangeError);
  });

  it('NaN lineTotalCents ⇒ throws RangeError', () => {
    expect(() => computeInvoiceTotals([{ lineTotalCents: NaN }])).toThrow(RangeError);
  });

  it('Infinity lineTotalCents ⇒ throws RangeError', () => {
    expect(() => computeInvoiceTotals([{ lineTotalCents: Infinity }])).toThrow(RangeError);
  });

  it('mixed valid + invalid: throws on the invalid line', () => {
    expect(() =>
      computeInvoiceTotals([{ lineTotalCents: 100 }, { lineTotalCents: -5 }]),
    ).toThrow(RangeError);
  });
});

// ─── Unit edges — applyPricingGroupDiscount ───────────────────────────────────

describe('applyPricingGroupDiscount — unit edges', () => {
  it('0 bps ⇒ identity (no discount)', () => {
    expect(applyPricingGroupDiscount(10000, 0)).toBe(10000);
    expect(applyPricingGroupDiscount(0, 0)).toBe(0);
  });

  it('10000 bps (100%) ⇒ 0 (full discount)', () => {
    expect(applyPricingGroupDiscount(10000, 10000)).toBe(0);
    expect(applyPricingGroupDiscount(1, 10000)).toBe(0);
  });

  it('5000 bps (50%) on 10000 ⇒ 5000', () => {
    // 10000 × 0.5 = 5000.0 → 5000
    expect(applyPricingGroupDiscount(10000, 5000)).toBe(5000);
  });

  it('500 bps (5%) on 10000 ⇒ 9500 (i.e. $95.00 after 5% off $100.00)', () => {
    // 10000 × 0.95 = 9500.0 → 9500
    expect(applyPricingGroupDiscount(10000, 500)).toBe(9500);
  });

  it('round-half-up at .5 cent: 5000 bps on 1 cent ⇒ 1 (half rounds up, result clamped)', () => {
    // 1 × 0.5 = 0.5 → floor(0.5 + 0.5) = floor(1.0) = 1; clamp to [0,1] → 1
    expect(applyPricingGroupDiscount(1, 5000)).toBe(1);
  });

  it('result never exceeds amountCents', () => {
    // Defensive clamp — discounting cannot inflate
    const result = applyPricingGroupDiscount(1000, 0);
    expect(result).toBeLessThanOrEqual(1000);
  });

  it('result is always a non-negative integer', () => {
    expect(Number.isInteger(applyPricingGroupDiscount(10000, 333))).toBe(true);
    expect(applyPricingGroupDiscount(10000, 333)).toBeGreaterThanOrEqual(0);
  });

  it('discountBps > 10000 is clamped to 10000 (full discount)', () => {
    expect(applyPricingGroupDiscount(10000, 99999)).toBe(0);
  });

  it('zero amountCents ⇒ 0 regardless of bps', () => {
    expect(applyPricingGroupDiscount(0, 500)).toBe(0);
    expect(applyPricingGroupDiscount(0, 10000)).toBe(0);
  });
});

// ─── applyPricingGroupDiscount error paths ────────────────────────────────────

describe('applyPricingGroupDiscount — error paths', () => {
  it('negative amountCents ⇒ throws RangeError', () => {
    expect(() => applyPricingGroupDiscount(-1, 500)).toThrow(RangeError);
  });

  it('non-integer amountCents ⇒ throws RangeError', () => {
    expect(() => applyPricingGroupDiscount(1.5, 500)).toThrow(RangeError);
  });

  it('NaN amountCents ⇒ throws RangeError', () => {
    expect(() => applyPricingGroupDiscount(NaN, 500)).toThrow(RangeError);
  });

  it('Infinity amountCents ⇒ throws RangeError', () => {
    expect(() => applyPricingGroupDiscount(Infinity, 500)).toThrow(RangeError);
  });

  it('negative discountBps ⇒ throws RangeError', () => {
    expect(() => applyPricingGroupDiscount(1000, -1)).toThrow(RangeError);
  });

  it('NaN discountBps ⇒ throws RangeError', () => {
    expect(() => applyPricingGroupDiscount(1000, NaN)).toThrow(RangeError);
  });

  it('Infinity discountBps ⇒ throws RangeError', () => {
    expect(() => applyPricingGroupDiscount(1000, Infinity)).toThrow(RangeError);
  });
});

// ─── P1 Non-negativity ────────────────────────────────────────────────────────

describe('P1 — Non-negativity: non-negative inputs ⇒ result >= 0', () => {
  it('applyRate: non-negative inputs always yield non-negative result', () => {
    fc.assert(
      fc.property(gridHours, rateCents, (h, r) => {
        expect(applyRate(h, r)).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('computeInvoiceTotals: non-negative lines always yield non-negative totals', () => {
    fc.assert(
      fc.property(lineItems, (lines) => {
        const result = computeInvoiceTotals(lines);
        expect(result.subtotalCents).toBeGreaterThanOrEqual(0);
        expect(result.totalCents).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

// ─── P2 Integer result ────────────────────────────────────────────────────────

describe('P2 — Integer result: applyRate always returns an integer', () => {
  it('applyRate returns an integer for all on-grid hours and integer rates', () => {
    fc.assert(
      fc.property(gridHours, rateCents, (h, r) => {
        expect(Number.isInteger(applyRate(h, r))).toBe(true);
      }),
    );
  });
});

// ─── P3 Zero hours ────────────────────────────────────────────────────────────

describe('P3 — Zero hours ⇒ 0 for any rate', () => {
  it('applyRate(0, r) === 0 for all non-negative rates', () => {
    fc.assert(
      fc.property(rateCents, (r) => {
        expect(applyRate(0, r)).toBe(0);
      }),
    );
  });
});

// ─── P4 Zero rate ─────────────────────────────────────────────────────────────

describe('P4 — Zero rate ⇒ 0 for any hours', () => {
  it('applyRate(h, 0) === 0 for all non-negative hours', () => {
    fc.assert(
      fc.property(gridHours, (h) => {
        expect(applyRate(h, 0)).toBe(0);
      }),
    );
  });
});

// ─── P5 Determinism ───────────────────────────────────────────────────────────

describe('P5 — Determinism: same input ⇒ same output (pure)', () => {
  it('applyRate: identical call twice ⇒ identical result', () => {
    fc.assert(
      fc.property(gridHours, rateCents, (h, r) => {
        expect(applyRate(h, r)).toBe(applyRate(h, r));
      }),
    );
  });

  it('computeInvoiceTotals: identical input twice ⇒ deep-equal result', () => {
    fc.assert(
      fc.property(lineItems, (lines) => {
        const r1 = computeInvoiceTotals(lines);
        const r2 = computeInvoiceTotals(lines);
        expect(r1).toEqual(r2);
      }),
    );
  });
});

// ─── P6 subtotalCents === Σ lineTotalCents ────────────────────────────────────

describe('P6 — subtotalCents === Σ lineTotalCents (exact integer sum)', () => {
  it('computeInvoiceTotals subtotal equals manual sum of all line totals', () => {
    fc.assert(
      fc.property(lineItems, (lines) => {
        const result = computeInvoiceTotals(lines);
        const manualSum = lines.reduce((acc, l) => acc + l.lineTotalCents, 0);
        expect(result.subtotalCents).toBe(manualSum);
      }),
    );
  });
});

// ─── P7 Commutativity / ordering independence ──────────────────────────────────

describe('P7 — Ordering independence: line order does not change subtotal', () => {
  it('shuffled line array produces the same subtotal', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 50 })
          .map((arr) => arr.map((v): InvoiceLine => ({ lineTotalCents: v }))),
        (lines) => {
          // Reverse as a simple permutation
          const reversed = [...lines].reverse();
          const r1 = computeInvoiceTotals(lines);
          const r2 = computeInvoiceTotals(reversed);
          expect(r1.subtotalCents).toBe(r2.subtotalCents);
          expect(r1.totalCents).toBe(r2.totalCents);
        },
      ),
    );
  });
});

// ─── P8 totalCents === subtotalCents (B1 invariant) ───────────────────────────

describe('P8 — B1 invariant: totalCents === subtotalCents', () => {
  it('computeInvoiceTotals: totalCents always equals subtotalCents in B1', () => {
    fc.assert(
      fc.property(lineItems, (lines) => {
        const result = computeInvoiceTotals(lines);
        expect(result.totalCents).toBe(result.subtotalCents);
      }),
    );
  });
});

// ─── P9 Adding a zero-amount line does not change subtotal ────────────────────

describe('P9 — Adding a zero-amount line does not change the subtotal', () => {
  it('computeInvoiceTotals: appending { lineTotalCents: 0 } is identity', () => {
    fc.assert(
      fc.property(lineItems, (lines) => {
        const base = computeInvoiceTotals(lines);
        const withZero = computeInvoiceTotals([...lines, { lineTotalCents: 0 }]);
        expect(withZero.subtotalCents).toBe(base.subtotalCents);
      }),
    );
  });
});

// ─── P10 Single-line invoice equals its own lineTotalCents ────────────────────

describe('P10 — Single-line invoice: subtotalCents === lineTotalCents', () => {
  it('computeInvoiceTotals([one line]).subtotalCents === that line total', () => {
    fc.assert(
      fc.property(intCents, (v) => {
        const result = computeInvoiceTotals([{ lineTotalCents: v }]);
        expect(result.subtotalCents).toBe(v);
        expect(result.totalCents).toBe(v);
      }),
    );
  });
});

// ─── P11 Large values: no float overflow ─────────────────────────────────────

describe('P11 — Large values: results stay within safe integer range', () => {
  it('applyRate with large but realistic values stays safe', () => {
    // 10000 hours × $10000/hr = $100M = 10_000_000_000 cents (10B)
    // Number.MAX_SAFE_INTEGER = 9_007_199_254_740_991 >> 10_000_000_000
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }).map((t) => t / 10), // hours 0..1000.0
        fc.integer({ min: 0, max: 1_000_000 }),                  // rate 0..$10000/hr
        (h, r) => {
          const result = applyRate(h, r);
          expect(Number.isSafeInteger(result)).toBe(true);
        },
      ),
    );
  });

  it('computeInvoiceTotals: 1000 lines × 100000 cents stays safe', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 0, maxLength: 1_000 })
          .map((arr): InvoiceLine[] => arr.map((v) => ({ lineTotalCents: v }))),
        (lines) => {
          const result = computeInvoiceTotals(lines);
          expect(Number.isSafeInteger(result.subtotalCents)).toBe(true);
          expect(Number.isSafeInteger(result.totalCents)).toBe(true);
        },
      ),
    );
  });
});

// ─── P12 applyPricingGroupDiscount result in [0, amountCents] ────────────────

describe('P12 — applyPricingGroupDiscount result in [0, amountCents]', () => {
  it('discounted result is never negative and never exceeds the original', () => {
    fc.assert(
      fc.property(intCents, bpsGen, (amount, bps) => {
        const result = applyPricingGroupDiscount(amount, bps);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(amount);
      }),
    );
  });
});

// ─── P13 applyPricingGroupDiscount(n, 0) === n ────────────────────────────────

describe('P13 — 0 bps discount is the identity', () => {
  it('applyPricingGroupDiscount(n, 0) === n for all non-negative integer n', () => {
    fc.assert(
      fc.property(intCents, (n) => {
        expect(applyPricingGroupDiscount(n, 0)).toBe(n);
      }),
    );
  });
});

// ─── P14 applyPricingGroupDiscount(n, 10000) === 0 ───────────────────────────

describe('P14 — 10000 bps (100% discount) always yields 0', () => {
  it('applyPricingGroupDiscount(n, 10000) === 0 for all non-negative integer n', () => {
    fc.assert(
      fc.property(intCents, (n) => {
        expect(applyPricingGroupDiscount(n, 10_000)).toBe(0);
      }),
    );
  });
});

// ─── P15 applyRate / computeLineTotal are byte-for-byte equivalent ─────────────

describe('P15 — computeLineTotal === applyRate for all valid inputs', () => {
  it('computeLineTotal(h, r) === applyRate(h, r) for all on-grid hours + rates', () => {
    fc.assert(
      fc.property(gridHours, rateCents, (h, r) => {
        expect(computeLineTotal(h, r)).toBe(applyRate(h, r));
      }),
    );
  });
});

// ─── P16 Precondition: negative input ⇒ throws ────────────────────────────────

describe('P16 — applyRate throws RangeError on negative inputs', () => {
  it('negative hours ⇒ always throws RangeError', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }).map((t) => t / 10), rateCents, (h, r) => {
        expect(() => applyRate(-h, r)).toThrow(RangeError);
      }),
    );
  });

  it('negative rate ⇒ always throws RangeError', () => {
    fc.assert(
      fc.property(gridHours, fc.integer({ min: 1, max: 1_000_000 }), (h, r) => {
        expect(() => applyRate(h, -r)).toThrow(RangeError);
      }),
    );
  });
});

// ─── P17 computeInvoiceTotals: invalid line ⇒ throws ─────────────────────────

describe('P17 — computeInvoiceTotals throws on invalid lineTotalCents', () => {
  it('non-integer lineTotalCents ⇒ always throws RangeError', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 999.99, noNaN: true, noDefaultInfinity: true })
          .filter((x) => !Number.isInteger(x)),
        (fractional) => {
          expect(() =>
            computeInvoiceTotals([{ lineTotalCents: fractional }]),
          ).toThrow(RangeError);
        },
      ),
    );
  });

  it('negative lineTotalCents ⇒ always throws RangeError', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (v) => {
        expect(() => computeInvoiceTotals([{ lineTotalCents: -v }])).toThrow(RangeError);
      }),
    );
  });
});

// ─── Type export surface (compile-time doc) ───────────────────────────────────

describe('type exports — compile-time structural assertions', () => {
  it('InvoiceLine has exactly lineTotalCents key', () => {
    const line: InvoiceLine = { lineTotalCents: 100 };
    expect(Object.keys(line)).toEqual(['lineTotalCents']);
  });

  it('InvoiceTotals has subtotalCents and totalCents keys', () => {
    const totals: InvoiceTotals = computeInvoiceTotals([{ lineTotalCents: 100 }]);
    const keys = Object.keys(totals).sort();
    expect(keys).toEqual(['subtotalCents', 'totalCents']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Slice P2 — computeCounterSaleLineTotal (POS / counter sales)
//
// P-CS-1  For arbitrary positive-int quantity + non-negative-int price, result
//         is a non-negative integer and equals repeated addition (no float step).
// P-CS-2  No-float-drift: computeInvoiceTotals over many computeCounterSaleLineTotal
//         lines is the EXACT integer sum — pinned across many randomized cases.
// P-CS-3  Throws RangeError on non-integer/zero/negative quantity, non-integer/
//         negative price, non-finite inputs.
// ════════════════════════════════════════════════════════════════════════════

/** A positive integer quantity [1..10_000] (item count, not hours). */
const posQuantity = fc.integer({ min: 1, max: 10_000 });

/** A non-negative integer unit price in cents [0..1_000_000] ($0–$10,000). */
const unitPriceCentsGen = fc.integer({ min: 0, max: 1_000_000 });

describe('computeCounterSaleLineTotal — unit edges', () => {
  it('quantity=1, price=0 ⇒ 0', () => {
    expect(computeCounterSaleLineTotal(1, 0)).toBe(0);
  });

  it('quantity=2, price=15000 ⇒ 30000', () => {
    expect(computeCounterSaleLineTotal(2, 15000)).toBe(30000);
  });

  it('quantity=1, price=1 ⇒ 1', () => {
    expect(computeCounterSaleLineTotal(1, 1)).toBe(1);
  });
});

describe('computeCounterSaleLineTotal — error paths', () => {
  it('quantity=0 ⇒ throws RangeError', () => {
    expect(() => computeCounterSaleLineTotal(0, 100)).toThrow(RangeError);
  });

  it('negative quantity ⇒ throws RangeError', () => {
    expect(() => computeCounterSaleLineTotal(-1, 100)).toThrow(RangeError);
  });

  it('non-integer quantity ⇒ throws RangeError', () => {
    expect(() => computeCounterSaleLineTotal(1.5, 100)).toThrow(RangeError);
  });

  it('negative price ⇒ throws RangeError', () => {
    expect(() => computeCounterSaleLineTotal(1, -1)).toThrow(RangeError);
  });

  it('non-integer price ⇒ throws RangeError', () => {
    expect(() => computeCounterSaleLineTotal(1, 100.5)).toThrow(RangeError);
  });

  it('NaN quantity ⇒ throws RangeError', () => {
    expect(() => computeCounterSaleLineTotal(NaN, 100)).toThrow(RangeError);
  });

  it('Infinity price ⇒ throws RangeError', () => {
    expect(() => computeCounterSaleLineTotal(1, Infinity)).toThrow(RangeError);
  });
});

describe('P-CS-1 — non-negative integer result, equals repeated addition', () => {
  it('result is a non-negative integer and equals quantity copies of price added', () => {
    fc.assert(
      fc.property(posQuantity, unitPriceCentsGen, (q, p) => {
        const result = computeCounterSaleLineTotal(q, p);
        expect(Number.isInteger(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(0);

        // Repeated addition (bounded — cap q at a small sample to keep the
        // property fast without losing coverage of the invariant).
        const sampleQ = Math.min(q, 200);
        let sum = 0;
        for (let i = 0; i < sampleQ; i += 1) sum += p;
        if (sampleQ === q) {
          expect(result).toBe(sum);
        } else {
          // For large q, verify via the exact multiplication identity instead
          // (both are integers — no float step possible).
          expect(result).toBe(q * p);
        }
      }),
    );
  });
});

describe('P-CS-2 — no float drift across many randomized lines', () => {
  it('computeInvoiceTotals over computeCounterSaleLineTotal lines is the exact integer sum', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(posQuantity, unitPriceCentsGen), { minLength: 0, maxLength: 500 }),
        (pairs) => {
          const lines = pairs.map(([q, p]) => ({
            lineTotalCents: computeCounterSaleLineTotal(q, p),
          }));
          const totals = computeInvoiceTotals(lines);
          const exactSum = pairs.reduce((acc, [q, p]) => acc + q * p, 0);
          expect(totals.subtotalCents).toBe(exactSum);
          expect(totals.totalCents).toBe(exactSum);
          expect(Number.isInteger(totals.subtotalCents)).toBe(true);
        },
      ),
    );
  });
});

describe('P-CS-3 — throws RangeError on invalid inputs (property)', () => {
  it('zero/negative/non-integer quantity ⇒ always throws', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -1000, max: 0 }),
          fc.double({ min: 0.1, max: 1000, noNaN: true, noDefaultInfinity: true }).filter((x) => !Number.isInteger(x)),
        ),
        unitPriceCentsGen,
        (badQ, p) => {
          expect(() => computeCounterSaleLineTotal(badQ, p)).toThrow(RangeError);
        },
      ),
    );
  });

  it('negative or non-integer price ⇒ always throws', () => {
    fc.assert(
      fc.property(
        posQuantity,
        fc.oneof(
          fc.integer({ min: -1_000_000, max: -1 }),
          fc.double({ min: 0.1, max: 1000, noNaN: true, noDefaultInfinity: true }).filter((x) => !Number.isInteger(x)),
        ),
        (q, badP) => {
          expect(() => computeCounterSaleLineTotal(q, badP)).toThrow(RangeError);
        },
      ),
    );
  });
});
