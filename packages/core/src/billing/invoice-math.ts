/**
 * billing/invoice-math.ts — pure invoice arithmetic (the @aeroops/core half of B1).
 *
 * No I/O, no Drizzle, no React, no clock, no randomness, NO Stripe, NO payment
 * data, NO card/bank anything. This is PURE ARITHMETIC that operators use to
 * compute invoice line amounts and totals from operator-entered rate schedules.
 *
 * MONEY = INTEGER CENTS. Every amount here is a whole number of cents (e.g. $125.00
 * = 12500). Floating-point is used ONLY as the hours quantity input (matching the
 * `numeric(10,1)` column shape, e.g. 1.3 hours) — the result of every money
 * operation is immediately rounded to integer cents. NEVER store or return a
 * fractional-cent value; floats are only a transient step to the integer result.
 *
 * ROUNDING RULE — round-half-up, applied ONCE per line:
 *   roundCents(x) = Math.floor(x + 0.5)
 *   This is "commercial rounding": 0.5 rounds to 1, 1.5 rounds to 2, etc.
 *   We use `Math.floor(x + 0.5)` rather than `Math.round(x)` to make the .5
 *   behaviour explicit and test-pinned: `Math.round(0.5)` is 1 in IEEE 754 but
 *   `Math.round(-0.5)` is 0 — since we guard non-negative inputs, they are
 *   equivalent for this domain, but `Math.floor(x + 0.5)` documents the intent
 *   unambiguously (no reliance on bank-rounding vs round-half-up tie-breaking).
 *   Concrete example: applyRate(1.3, 12500) = floor(16250.0 + 0.5) = floor(16250.5)
 *   = 16250 cents. If the product fell on exactly .5 cents, e.g. applyRate(1, 1)
 *   would never occur for realistic rates, but applyRate(0.3, 1) = floor(0.3+0.5)
 *   = floor(0.8) = 0. The rule is fully deterministic on all non-negative inputs.
 *
 * SEAMS FOR LATER SLICES:
 *   - Tax: `computeInvoiceTotals` returns `totalCents === subtotalCents` in B1.
 *     When B5/tax lands, the caller computes `taxCents` separately and passes it;
 *     or `computeInvoiceTotals` gets an optional `taxCents` param. See seam comment.
 *   - Discounts: `applyPricingGroupDiscount` is provided as a documented helper.
 *     It is NOT wired into `computeInvoiceTotals` in B1 — pricing-group discounts
 *     are applied per-line before the line total, or as a separate credit line, in
 *     a later slice. The function is here so the math is property-tested now.
 *
 * PART OF: Phase-2 B1 (records + pure invoice math). NO stripe, NO DB, NO money
 * moves. Consumed later by `generateInvoiceFromDispatch` (reads the frozen
 * `flight_time_hours`, NEVER recomputes it) — that DB integration is a separate
 * slice. [VERIFY-B-MONEY-1]: derived flight time is the billable basis.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * An invoice line item as seen by `computeInvoiceTotals`.
 * The caller computes `lineTotalCents` using `applyRate` (or manually for
 * non-rate lines like fees, fuel surcharges, manual adjustments).
 * All amounts are INTEGER CENTS (non-negative).
 */
export interface InvoiceLine {
  /** Pre-computed line total, in integer cents. Non-negative. */
  readonly lineTotalCents: number;
}

/**
 * Invoice totals — output of `computeInvoiceTotals`.
 *
 * In B1, `totalCents === subtotalCents`. The fields are distinct so the DB
 * integration and future tax/discount slices can extend the contract without
 * changing call sites: pass `totalCents` to the DB column, never `subtotalCents`
 * directly when a distinction exists.
 *
 * TAX SEAM: when B5/tax lands, `computeInvoiceTotals` will accept an optional
 * `{ taxCents: number }` and return `totalCents = subtotalCents + taxCents`.
 * Until then: `totalCents === subtotalCents === Σ lineTotalCents`.
 */
export interface InvoiceTotals {
  /** Sum of all `lineTotalCents` values — integer cents. */
  readonly subtotalCents: number;
  /**
   * Amount due — in B1 always === subtotalCents (no tax/global discount yet).
   * Future seam: totalCents = subtotalCents + taxCents - creditCents.
   */
  readonly totalCents: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Round a money amount (fractional cents) to integer cents using round-half-up.
 *
 * Math.floor(x + 0.5) gives conventional "commercial" round-half-up:
 *   0.4 → 0, 0.5 → 1, 1.5 → 2, -0.5 → 0 (non-negative domain; -0.5 doesn't occur)
 *
 * This is applied ONCE per money operation — never to individual inputs, always
 * to the final computed amount. Mirrors the `deriveFlightTime` discipline:
 * "Rounding is applied to the result only — never to the inputs — so the rule
 * composes predictably for callers."
 *
 * Domain note: for non-negative `x`, `Math.floor(x + 0.5)` and
 * `Math.round(x)` are equivalent (IEEE 754 round-half-to-even only affects
 * values at exactly .5 in the negative range). We use the explicit form to
 * pin the documented intent and keep it test-verifiable at .5 boundaries.
 */
function roundCents(x: number): number {
  return Math.floor(x + 0.5);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * applyRate — compute the line total for one unit of hours at a rate.
 *
 * line total = round-half-up(hours × ratePerHourCents)
 *
 * ROUNDING: round-half-up applied ONCE to the product. See module-level comment.
 * CONCRETE EXAMPLE: applyRate(1.3, 12500) = floor(16250.0 + 0.5) = 16250 cents.
 * CONCRETE EXAMPLE: applyRate(0.5, 1) = floor(0.5 + 0.5) = floor(1.0) = 1 cent.
 * CONCRETE EXAMPLE: applyRate(0, 12500) = 0 cents.
 * CONCRETE EXAMPLE: applyRate(1.3, 0) = 0 cents.
 *
 * @param hours            quantity — decimal hours (e.g. 1.3). Non-negative.
 *                         Matches `numeric(10,1)` shape from `flight_time_hours`.
 *                         Off-grid values are accepted (e.g. for manual overrides).
 * @param ratePerHourCents rate per hour in INTEGER CENTS (e.g. 12500 = $125.00).
 *                         Non-negative integer. A fractional value is a caller
 *                         bug and throws RangeError — rates are always stored as
 *                         integer cents; fractional values must not be silently
 *                         rounded in audit-grade billing records.
 * @returns integer cents, non-negative. Never fractional. Never negative.
 * @throws RangeError if either argument is negative, NaN, or non-finite, or
 *                    if ratePerHourCents is not an integer.
 */
export function applyRate(hours: number, ratePerHourCents: number): number {
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(ratePerHourCents) ||
    hours < 0 ||
    ratePerHourCents < 0
  ) {
    throw new RangeError(
      `applyRate: hours (${hours}) and ratePerHourCents (${ratePerHourCents}) must be finite and non-negative`,
    );
  }
  // Rates MUST be integer cents — a fractional ratePerHourCents is a caller bug
  // (rates are always stored as integer cents in the DB). Throw rather than silently
  // rounding, so callers discover the problem at the boundary instead of getting a
  // subtly wrong result in audit-grade billing records.
  if (!Number.isInteger(ratePerHourCents)) {
    throw new RangeError(
      `applyRate: ratePerHourCents must be an integer, got ${ratePerHourCents}`,
    );
  }
  // Compute product; round-half-up once to integer cents.
  // hours is a legitimate fractional quantity (numeric(10,1) — e.g. 1.3 hours).
  return roundCents(hours * ratePerHourCents);
}

/**
 * computeLineTotal — alias for `applyRate`, named for the "line total" context.
 *
 * Provided as an alternative entry point for callers who prefer the "line total"
 * vocabulary over the "rate × hours" vocabulary. Identical behaviour.
 *
 * @param quantityHours    hours quantity, non-negative (matches `applyRate` `hours`).
 * @param unitAmountCents  rate per hour in cents, non-negative (matches `ratePerHourCents`).
 * @returns integer cents — same as `applyRate(quantityHours, unitAmountCents)`.
 * @throws RangeError same preconditions as `applyRate`.
 */
export function computeLineTotal(
  quantityHours: number,
  unitAmountCents: number,
): number {
  return applyRate(quantityHours, unitAmountCents);
}

/**
 * computeInvoiceTotals — sum all invoice lines into subtotal + total.
 *
 * `subtotalCents` = Σ lineTotalCents (integer summation, NO rounding applied —
 * each `lineTotalCents` is already an integer, so the sum is exact).
 *
 * In B1: `totalCents === subtotalCents`. The field is distinct for the tax/
 * discount seam described in the module-level comment.
 *
 * ZERO-LINE EDGE: an empty `lines` array returns `{ subtotalCents: 0, totalCents: 0 }`.
 *
 * @param lines  Array of pre-computed line items. Each `lineTotalCents` must be a
 *               non-negative integer. The function validates and throws on violation.
 *               `ReadonlyArray` so callers may pass frozen objects / `as const`.
 * @returns `InvoiceTotals` with both fields as non-negative integers.
 * @throws RangeError if any `lineTotalCents` is negative, non-finite, or non-integer.
 */
export function computeInvoiceTotals(
  lines: ReadonlyArray<InvoiceLine>,
): InvoiceTotals {
  let subtotal = 0;
  for (const line of lines) {
    if (
      !Number.isFinite(line.lineTotalCents) ||
      line.lineTotalCents < 0 ||
      !Number.isInteger(line.lineTotalCents)
    ) {
      throw new RangeError(
        `computeInvoiceTotals: lineTotalCents must be a non-negative integer, got ${line.lineTotalCents}`,
      );
    }
    subtotal += line.lineTotalCents;
  }
  // subtotal is an exact integer sum — no rounding needed.
  return { subtotalCents: subtotal, totalCents: subtotal };
}

/**
 * applyPricingGroupDiscount — apply a basis-point discount to an amount.
 *
 * FUTURE SEAM (B1 ships this helper, B4 block-time / pricing-group wiring consumes
 * it). A pricing group discount is expressed in BASIS POINTS (bps), where
 * 100 bps = 1%. Stored as an integer (e.g. 500 = 5%).
 *
 * discountedAmount = round-half-up(amountCents × (1 - discountBps / 10_000))
 *
 * Bounded: the result is clamped to [0, amountCents] — a discount cannot produce
 * a negative amount or an amount larger than the original.
 *
 * CONCRETE EXAMPLE: applyPricingGroupDiscount(10000, 500) = round(10000 × 0.95)
 *   = round(9500.0) = 9500. Discount = 500 cents.
 * CONCRETE EXAMPLE: applyPricingGroupDiscount(1, 5000) = round(1 × 0.5)
 *   = round(0.5) = floor(0.5 + 0.5) = floor(1.0) = 1 — round-half-up at .5.
 * CONCRETE EXAMPLE: applyPricingGroupDiscount(1, 10000) = 0 (100% discount).
 *
 * [VERIFY-B-PRICING-GROUP]: this function is NOT wired into computeInvoiceTotals
 * in B1. Callers apply it per-line BEFORE constructing InvoiceLine, or as a
 * separate credit/adjustment line, per the B4 slice's design. The API and billing
 * integration slices decide the application point.
 *
 * NOT an FAA determination. NOT Stripe. NOT a real money transfer.
 *
 * @param amountCents   base amount in integer cents, non-negative.
 * @param discountBps   discount in basis points [0..10_000], non-negative integer.
 *                      0 = no discount; 10_000 = 100% (free). Values > 10_000 are
 *                      clamped to 10_000 (cannot discount more than 100%).
 * @returns integer cents — the discounted amount (non-negative, ≤ amountCents).
 * @throws RangeError if `amountCents` is negative, non-finite, or non-integer;
 *                    or if `discountBps` is negative or non-finite.
 */
export function applyPricingGroupDiscount(
  amountCents: number,
  discountBps: number,
): number {
  if (
    !Number.isFinite(amountCents) ||
    amountCents < 0 ||
    !Number.isInteger(amountCents)
  ) {
    throw new RangeError(
      `applyPricingGroupDiscount: amountCents must be a non-negative integer, got ${amountCents}`,
    );
  }
  if (!Number.isFinite(discountBps) || discountBps < 0) {
    throw new RangeError(
      `applyPricingGroupDiscount: discountBps must be a non-negative finite number, got ${discountBps}`,
    );
  }
  // Clamp to 100% discount
  const bps = Math.min(discountBps, 10_000);
  const factor = 1 - bps / 10_000;
  const discounted = roundCents(amountCents * factor);
  // Clamp to [0, amountCents] — defensive (rounding can never inflate, but
  // floating-point can in theory produce amountCents + 1 at extreme values).
  return Math.max(0, Math.min(amountCents, discounted));
}
