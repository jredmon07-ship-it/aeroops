/**
 * block-summary-math.ts — pure aggregation math for block-time (prepaid
 * package) purchase summaries (Slice B4 @aeroops/core).
 *
 * NO I/O, no Drizzle, no React, no clock, no randomness, NO Stripe, NO
 * card/bank anything. Money = INTEGER CENTS (never a float). Hours are a
 * QUANTITY (flight hours, up to 1 decimal place) — NOT money.
 *
 * INTEGER-EXACT HOUR SUMMATION: hours accumulate as TENTHS internally (the
 * SAME convention packages/api/src/logbook/internal.ts's buildPilotLog uses
 * for exactly this reason) so that repeated 1-decimal-place hour amounts sum
 * WITHOUT float drift — the tenths accumulator is divided back to a decimal
 * value exactly once, at the very end.
 *
 * v1 SCOPE NOTE (see docs/specs/slice-b4-block-time.md): this module
 * aggregates PURCHASE totals (hours bought, amount paid) for display. It does
 * NOT compute a per-flight hours-based discounted-rate DRAWDOWN — the
 * member's remaining prepaid credit is read from the EXISTING derived ledger
 * balance (computeBalance, ./ledger-math.js), not from a per-flight hour
 * meter. That drawdown model is explicitly DEFERRED past v1.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single block purchase as seen by `aggregateBlockPurchases`. Mirrors the
 * persisted `block_purchase` row's money/quantity-relevant columns exactly.
 */
export interface BlockPurchaseAmount {
  /** Hours in this purchase. Always a positive, finite number (up to 1 decimal place). */
  readonly hours: number;
  /** Amount paid, in integer cents. Always a positive integer. */
  readonly amountCents: number;
}

export interface BlockPurchaseTotals {
  /** Σ hours across every purchase — a QUANTITY, NOT money. */
  readonly totalHours: number;
  /** Σ amountCents across every purchase — INTEGER CENTS, never a float. */
  readonly totalAmountCents: number;
}

// ─── aggregateBlockPurchases ──────────────────────────────────────────────────

/**
 * aggregateBlockPurchases — sum a list of block purchases into purchase
 * totals (hours bought, amount paid).
 *
 * DETERMINISTIC + ORDER-INDEPENDENT: the result depends only on the multiset
 * of (hours, amountCents) pairs, never on array order.
 *
 * ZERO-ENTRY EDGE: an empty `purchases` array returns { totalHours: 0,
 * totalAmountCents: 0 }.
 *
 * @param purchases  Append-only block purchases (order-independent). Each
 *                   `amountCents` must be a positive integer; each `hours`
 *                   must be a positive finite number. Throws on violation
 *                   (never silently tolerates a malformed entry in
 *                   audit-grade money code).
 * @returns the aggregate totals. `totalAmountCents` is always a non-negative
 *          safe integer (integer closure — see property tests).
 * @throws RangeError if any `amountCents` is non-positive/non-finite/
 *                     non-integer, or any `hours` is non-positive/non-finite.
 */
export function aggregateBlockPurchases(
  purchases: ReadonlyArray<BlockPurchaseAmount>,
): BlockPurchaseTotals {
  let totalAmountCents = 0;
  let tenths = 0;

  for (const p of purchases) {
    if (
      !Number.isFinite(p.amountCents) ||
      !Number.isInteger(p.amountCents) ||
      p.amountCents <= 0
    ) {
      throw new RangeError(
        `aggregateBlockPurchases: amountCents must be a positive integer, got ${p.amountCents}`,
      );
    }
    if (!Number.isFinite(p.hours) || p.hours <= 0) {
      throw new RangeError(
        `aggregateBlockPurchases: hours must be a positive finite number, got ${p.hours}`,
      );
    }
    totalAmountCents += p.amountCents;
    tenths += Math.round(p.hours * 10);
  }

  return { totalHours: tenths / 10, totalAmountCents };
}

// ─── computeEffectiveRateCentsPerHour ─────────────────────────────────────────

/**
 * computeEffectiveRateCentsPerHour — the effective discounted rate of a
 * block package: price_cents / hours, in cents per hour. DISPLAY ONLY — this
 * is NEVER summed, stored, or fed back into further money math; it is
 * rounded to the nearest whole cent purely for on-screen presentation (e.g.
 * "$42.86/hr").
 *
 * @param priceCents  The package's total price, in integer cents (> 0).
 * @param hours        The package's total hours (> 0).
 * @returns the effective rate, in cents per hour, rounded to the nearest
 *          integer cent for display.
 * @throws RangeError if priceCents is not a positive integer, or hours is
 *                     not a positive finite number.
 */
export function computeEffectiveRateCentsPerHour(priceCents: number, hours: number): number {
  if (!Number.isFinite(priceCents) || !Number.isInteger(priceCents) || priceCents <= 0) {
    throw new RangeError(
      `computeEffectiveRateCentsPerHour: priceCents must be a positive integer, got ${priceCents}`,
    );
  }
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new RangeError(
      `computeEffectiveRateCentsPerHour: hours must be a positive finite number, got ${hours}`,
    );
  }
  return Math.round(priceCents / hours);
}
