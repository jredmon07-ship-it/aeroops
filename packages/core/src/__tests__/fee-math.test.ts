/**
 * fee-math.test.ts — unit + property tests for computeAchPassthroughFeeCents
 * (the pure ACH pass-through processing-fee math). PROPERTY-BASED per CLAUDE.md
 * ("money math gets PROPERTY-BASED tests").
 *
 * FEE RULE: fee = min( round-half-up(baseCents × 0.01), 1000 ).
 *
 * WHAT WE PROVE:
 *   Unit targets: 0 / tiny / just-under-cap / exact cap / over cap / negatives.
 *   Properties: bounds [0,1000], monotonicity, cap saturation, ~1% below cap.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  computeAchPassthroughFeeCents,
  ACH_FEE_CAP_CENTS,
} from '../billing/fee-math.js';

describe('computeAchPassthroughFeeCents — unit targets', () => {
  it('zero base ⇒ 0 fee', () => {
    expect(computeAchPassthroughFeeCents(0)).toBe(0);
  });

  it('tiny base rounds half-up (50¢ → round(0.5) = 1¢)', () => {
    expect(computeAchPassthroughFeeCents(50)).toBe(1);
    // 49¢ → round(0.49) = 0
    expect(computeAchPassthroughFeeCents(49)).toBe(0);
    // 1¢ → round(0.01) = 0
    expect(computeAchPassthroughFeeCents(1)).toBe(0);
    // $1.00 → 1¢
    expect(computeAchPassthroughFeeCents(100)).toBe(1);
  });

  it('just under the cap: $999.00 → 999¢', () => {
    expect(computeAchPassthroughFeeCents(99_900)).toBe(999);
  });

  it('exactly at the cap boundary: $1000.00 → 1000¢ ($10 cap)', () => {
    expect(computeAchPassthroughFeeCents(100_000)).toBe(1000);
  });

  it('over the cap saturates at 1000¢: $5000 → 1000¢', () => {
    expect(computeAchPassthroughFeeCents(500_000)).toBe(ACH_FEE_CAP_CENTS);
    expect(computeAchPassthroughFeeCents(100_100)).toBe(1000);
  });

  it('negative / non-finite / non-integer base ⇒ 0 (never a negative fee)', () => {
    expect(computeAchPassthroughFeeCents(-100)).toBe(0);
    expect(computeAchPassthroughFeeCents(Number.NaN)).toBe(0);
    expect(computeAchPassthroughFeeCents(Number.POSITIVE_INFINITY)).toBe(0);
    expect(computeAchPassthroughFeeCents(100.5)).toBe(0);
  });
});

describe('computeAchPassthroughFeeCents — properties', () => {
  it('P1 bounds: result is always an integer in [0, 1000]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000 }), (base) => {
        const fee = computeAchPassthroughFeeCents(base);
        expect(Number.isInteger(fee)).toBe(true);
        expect(fee).toBeGreaterThanOrEqual(0);
        expect(fee).toBeLessThanOrEqual(ACH_FEE_CAP_CENTS);
      }),
    );
  });

  it('P2 monotonic non-decreasing in base', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: 0, max: 100_000_000 }),
        (a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          expect(computeAchPassthroughFeeCents(hi)).toBeGreaterThanOrEqual(
            computeAchPassthroughFeeCents(lo),
          );
        },
      ),
    );
  });

  it('P3 cap saturation: any base ≥ $1000 yields exactly 1000¢', () => {
    fc.assert(
      fc.property(fc.integer({ min: 100_000, max: 100_000_000 }), (base) => {
        expect(computeAchPassthroughFeeCents(base)).toBe(ACH_FEE_CAP_CENTS);
      }),
    );
  });

  it('P4 below the cap the fee is within 1 cent of 1% of base', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99_900 }), (base) => {
        const fee = computeAchPassthroughFeeCents(base);
        expect(Math.abs(fee - base * 0.01)).toBeLessThanOrEqual(0.5);
      }),
    );
  });
});
