/**
 * billing/fee-math.ts — pure ACH processing-fee arithmetic (fee-passing feature).
 *
 * No I/O, no Drizzle, no React, no clock, no randomness, NO Stripe, NO card/bank
 * anything. PURE ARITHMETIC over integer cents — safe to import from a client
 * bundle (mirrors invoice-math.ts / ledger-math.ts).
 *
 * MONEY = INTEGER CENTS. The fee is a percentage of the base amount, rounded to
 * whole cents and CAPPED. This models the "1%-capped-$15 ACH" pricing:
 * the operator (org) may optionally pass this processing fee through to the member
 * at checkout.
 *
 * FEE RULE (load-bearing — pin here):
 *   fee = min( round(baseCents × 0.01), 1500 )
 *   i.e. 1% of the base, rounded half-up to whole cents, capped at $15.00 (1500¢).
 *
 * A non-positive / non-finite base yields a 0 fee (never a negative fee, never a
 * fee on a zero amount). The result is ALWAYS a non-negative integer ≤ 1500.
 *
 * MONEY-BOUNDARY NOTE: this computes the AMOUNT a member is quoted at checkout
 * when the operator has opted into fee-passing. It moves no money and knows
 * nothing about Stripe. The fee is the platform's — carried in PaymentIntent
 * metadata; the ledger credit posts the BASE only (the real fee split activates
 * with Stripe Connect later). See packages/api/src/portal/pay-invoice.ts.
 */

/** Processing-fee rate: 1% of the base amount. */
export const ACH_FEE_RATE = 0.01;

/** Processing-fee cap: $15.00, in integer cents. */
export const ACH_FEE_CAP_CENTS = 1500;

/**
 * computeAchPassthroughFeeCents — the pass-through processing fee for a base
 * amount, in INTEGER CENTS.
 *
 * fee = min( round-half-up(baseCents × 0.01), 1500 )
 *
 * ROUNDING: round-half-up applied ONCE to the product (Math.floor(x + 0.5)),
 * matching invoice-math.ts's `roundCents` discipline.
 *
 * CONCRETE EXAMPLES:
 *   computeAchPassthroughFeeCents(0)      = 0        (zero base → no fee)
 *   computeAchPassthroughFeeCents(50)     = 1        (round(0.5) = 1)
 *   computeAchPassthroughFeeCents(100)    = 1        ($1.00 → 1¢)
 *   computeAchPassthroughFeeCents(149900) = 1499     (just under the cap)
 *   computeAchPassthroughFeeCents(150000) = 1500     ($1500 → exactly $15 cap)
 *   computeAchPassthroughFeeCents(500000) = 1500     ($5000 → capped at $15)
 *
 * @param baseCents  the base amount in integer cents. A non-positive, non-finite,
 *                   or non-integer value returns 0 (defensive — never throws in
 *                   the checkout path; the caller has already validated the
 *                   invoice/balance amount).
 * @returns integer cents in [0, 1500].
 */
export function computeAchPassthroughFeeCents(baseCents: number): number {
  if (!Number.isFinite(baseCents) || !Number.isInteger(baseCents) || baseCents <= 0) {
    return 0;
  }
  const raw = Math.floor(baseCents * ACH_FEE_RATE + 0.5);
  return Math.min(raw, ACH_FEE_CAP_CENTS);
}
