/**
 * flight-time.test.ts — unit + property tests for the pure flight-time fn.
 *
 * This is where the DISPATCH-3a derivation PROPERTY tests live (ADR-0007
 * invariant 4, the hard guardrail). The pure fn computes billable HOURS from a
 * meter pair, round-half-up to the 0.1 grid, applied ONCE to the difference.
 *
 * Deterministic: no Date.now(), no Math.random() — fast-check seeds the only
 * randomness and generators are constrained to realistic meter ranges. Where a
 * property needs grid-aligned inputs we generate INTEGER tenths and divide by 10
 * (e.g. tenths=12345 → 1234.5) so generator noise never injects float junk that
 * the rounding rule would mask.
 *
 * COVERAGE:
 *   Unit edges:
 *     - out=0; identity at the tenth; 0.1 boundary; values near 9999.9
 *     - round-half-up at the .x5 difference; precondition throw
 *   Property (fast-check), per spec §2.6 / ADR-0007 inv.4:
 *     - P1 non-negativity: out>=0, delta>=0 ⇒ derive(out,out+delta) >= 0
 *     - P2 identity: derive(x,x) === 0
 *     - P3 monotonicity in `in`: fixed out, larger in ⇒ non-decreasing
 *     - P4 additivity across 0.1-grid splits (exact); + arbitrary off-grid
 *           splits bounded by |lhs - rhs| <= 0.1
 *     - P5 precision: output is a multiple of 0.1 AND within 0.05 of exact
 *     - P6 precondition guard: in < out ⇒ throws RangeError
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { deriveFlightTime } from '../flight-time.js';

// ─── Generators ──────────────────────────────────────────────────────────────

// A realistic meter reading on the 0.1 grid: integer tenths in [0, 99999]
// mapped to /10 ⇒ [0.0 .. 9999.9]. Generating tenths-as-integers (not floats)
// keeps inputs EXACTLY on the grid — no float-gen noise.
const gridTenths = fc.integer({ min: 0, max: 99_999 });
const gridMeter = gridTenths.map((t) => t / 10);

// A non-negative delta in tenths ⇒ on-grid hours in [0.0 .. 1000.0].
const gridDeltaTenths = fc.integer({ min: 0, max: 10_000 });

// An arbitrary (possibly off-grid) meter in a realistic range, for the
// rounding-bound properties. Bounded fractionDigits keeps values finite/sane.
const arbitraryMeter = fc
  .double({ min: 0, max: 9999.9, noNaN: true, noDefaultInfinity: true })
  .filter((x) => Number.isFinite(x));

/** Is `x` a multiple of 0.1 (to within float tolerance)? */
function isTenthMultiple(x: number): boolean {
  const scaled = x * 10;
  return Math.abs(scaled - Math.round(scaled)) < 1e-9;
}

// ─── Unit edges ──────────────────────────────────────────────────────────────

describe('deriveFlightTime — unit edges', () => {
  it('out=0: derive(0, in) === in for an on-grid in', () => {
    expect(deriveFlightTime(0, 1.2)).toBe(1.2);
    expect(deriveFlightTime(0, 0)).toBe(0);
  });

  it('identity at the tenth: derive(x, x) === 0', () => {
    expect(deriveFlightTime(1234.5, 1234.5)).toBe(0);
    expect(deriveFlightTime(0.1, 0.1)).toBe(0);
  });

  it('0.1 boundary: smallest non-zero difference', () => {
    expect(deriveFlightTime(1.0, 1.1)).toBe(0.1);
    expect(deriveFlightTime(0, 0.1)).toBe(0.1);
  });

  it('values near 9999.9 (numeric(10,1) ceiling)', () => {
    expect(deriveFlightTime(9999.8, 9999.9)).toBe(0.1);
    expect(deriveFlightTime(0, 9999.9)).toBe(9999.9);
    expect(deriveFlightTime(9000.0, 9999.9)).toBe(999.9);
  });

  it('plain on-grid difference: 1234.5 → 1236.0 === 1.5', () => {
    expect(deriveFlightTime(1234.5, 1236.0)).toBe(1.5);
  });

  it('round-half-up applied to the difference: a .x5 diff rounds UP', () => {
    // Exact difference 0.05 ⇒ rounds up to 0.1 (off-grid input, in isolation).
    expect(deriveFlightTime(0, 0.05)).toBe(0.1);
    // Exact difference 1.25 ⇒ rounds up to 1.3.
    expect(deriveFlightTime(0, 1.25)).toBe(1.3);
    // Below the half: 0.04 ⇒ rounds down to 0.0.
    expect(deriveFlightTime(0, 0.04)).toBe(0);
  });

  it('precondition: in < out throws RangeError', () => {
    expect(() => deriveFlightTime(10, 9.9)).toThrow(RangeError);
    expect(() => deriveFlightTime(1, 0)).toThrow(RangeError);
  });

  it('never returns -0', () => {
    expect(Object.is(deriveFlightTime(5, 5), -0)).toBe(false);
  });
});

// ─── P1 non-negativity ───────────────────────────────────────────────────────

describe('deriveFlightTime — P1 non-negativity', () => {
  it('out>=0, delta>=0 ⇒ derive(out, out+delta) >= 0', () => {
    fc.assert(
      fc.property(gridMeter, gridDeltaTenths, (out, deltaTenths) => {
        const result = deriveFlightTime(out, out + deltaTenths / 10);
        expect(result).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

// ─── P2 identity ─────────────────────────────────────────────────────────────

describe('deriveFlightTime — P2 identity', () => {
  it('derive(x, x) === 0 for any in-domain x', () => {
    fc.assert(
      fc.property(arbitraryMeter, (x) => {
        expect(deriveFlightTime(x, x)).toBe(0);
      }),
    );
  });
});

// ─── P3 monotonicity in `in` ─────────────────────────────────────────────────

describe('deriveFlightTime — P3 monotonicity', () => {
  it('fixed out, larger in ⇒ result is non-decreasing', () => {
    fc.assert(
      fc.property(gridMeter, gridDeltaTenths, gridDeltaTenths, (out, d1, d2) => {
        const lo = Math.min(d1, d2);
        const hi = Math.max(d1, d2);
        const rLo = deriveFlightTime(out, out + lo / 10);
        const rHi = deriveFlightTime(out, out + hi / 10);
        expect(rHi).toBeGreaterThanOrEqual(rLo);
      }),
    );
  });
});

// ─── P4 additivity ───────────────────────────────────────────────────────────

describe('deriveFlightTime — P4 additivity', () => {
  it('exact additivity across 0.1-grid splits: derive(a,c) === derive(a,b)+derive(b,c)', () => {
    fc.assert(
      fc.property(
        gridTenths,
        gridDeltaTenths,
        gridDeltaTenths,
        (aT, ab, bc) => {
          // a <= b <= c, all exactly on the 0.1 grid.
          const a = aT / 10;
          const b = (aT + ab) / 10;
          const c = (aT + ab + bc) / 10;
          const whole = deriveFlightTime(a, c);
          const parts =
            Math.round(
              (deriveFlightTime(a, b) + deriveFlightTime(b, c)) * 10,
            ) / 10;
          expect(parts).toBe(whole);
        },
      ),
    );
  });

  it('arbitrary (off-grid) splits: rounding bound |derive(a,c) - (derive(a,b)+derive(b,c))| <= 0.1', () => {
    fc.assert(
      fc.property(arbitraryMeter, arbitraryMeter, arbitraryMeter, (x, y, z) => {
        const [a, b, c] = [x, y, z].sort((p, q) => p - q); // a <= b <= c
        const whole = deriveFlightTime(a!, c!);
        const parts = deriveFlightTime(a!, b!) + deriveFlightTime(b!, c!);
        expect(Math.abs(whole - parts)).toBeLessThanOrEqual(0.1 + 1e-9);
      }),
    );
  });
});

// ─── P5 precision ────────────────────────────────────────────────────────────

describe('deriveFlightTime — P5 precision', () => {
  it('output is a multiple of 0.1 and within 0.05 of the exact difference', () => {
    fc.assert(
      fc.property(arbitraryMeter, arbitraryMeter, (x, y) => {
        const out = Math.min(x, y);
        const inn = Math.max(x, y);
        const result = deriveFlightTime(out, inn);
        // multiple of 0.1
        expect(isTenthMultiple(result)).toBe(true);
        // within half a tenth of the exact difference (round-half-up to 0.1)
        const exact = inn - out;
        expect(Math.abs(result - exact)).toBeLessThanOrEqual(0.05 + 1e-9);
      }),
    );
  });
});

// ─── P6 precondition guard ───────────────────────────────────────────────────

describe('deriveFlightTime — P6 precondition guard', () => {
  it('in < out ⇒ throws RangeError', () => {
    fc.assert(
      fc.property(gridMeter, fc.integer({ min: 1, max: 10_000 }), (out, dropT) => {
        const inn = out - dropT / 10; // strictly less than out
        expect(() => deriveFlightTime(out, inn)).toThrow(RangeError);
      }),
    );
  });
});
