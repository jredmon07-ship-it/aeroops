/**
 * dispatch-gate/balance-seam.ts — balance check interface + no-op stub.
 *
 * The `@aeroops/core` MONEY BOUNDARY for Slice 3c (ADR-0009 §2).
 *
 * [VERIFY-3c-MONEY] THIS IS A NO-OP STUB. There is ZERO payment, billing,
 * Stripe, card, bank, dollar, cent, minimum-balance, invoice, or account-balance
 * concept in Phase 1. `stubBalanceSeam.check()` ALWAYS returns `{ ok: true }`.
 *
 * The `BalanceCheckResult` type includes the `{ ok: false; reason: 'below_minimum' }`
 * arm ONLY as a RESERVED type-level seam so that Slice 3c API + openDispatch wiring
 * can express the future contract without shipping any money code. The stub NEVER
 * returns that arm. Only a test-injected fake seam can return it (to prove the
 * wiring is correct), and even then no real money computation occurs.
 *
 * `BalanceCheckRequest` intentionally has NO amount, minimum, currency, account,
 * balance, credit, or Stripe field. Any addition of such fields requires Phase 2
 * billing architecture review.
 *
 * `dispatch_config.balance_check_enabled` (DB) is a feature flag (default OFF).
 * Enabling it in Phase 1 has NO effect — the stub still returns { ok: true }.
 *
 * [VERIFY-3c-MONEY]: a real implementation must not be added until Phase 2
 * billing (Stripe) is fully architected and reviewed.
 */

/**
 * BalanceCheckRequest — the minimum identity needed to look up a balance.
 *
 * [VERIFY-3c-MONEY] INTENTIONALLY contains NO amount, minimum, currency,
 * account, Stripe, or dollar field. Add none without Phase 2 billing review.
 */
export interface BalanceCheckRequest {
  orgId: string;
  pilotUserId: string;
}

/**
 * BalanceCheckResult — outcome of a balance check.
 *
 *   { ok: true }                          — pilot may proceed (the only result in Phase 1).
 *   { ok: false; reason: 'below_minimum' } — RESERVED; stub never returns this arm.
 *                                            Only a test-injected fake seam returns it.
 *
 * [VERIFY-3c-MONEY] 'below_minimum' is a type-level placeholder only. It carries
 * no dollar value or minimum threshold — those belong to Phase 2.
 */
export type BalanceCheckResult =
  | { ok: true }
  | { ok: false; reason: 'below_minimum' }; // RESERVED — unreachable via stub in Phase 1

/**
 * BalanceSeam — the injected interface for balance checking.
 *
 * The sole implementation in Phase 1 is `stubBalanceSeam`. Phase 2 will inject
 * a real Stripe-backed implementation via this interface without changing
 * openDispatch's signature.
 *
 * [VERIFY-3c-MONEY] Implementors MUST NOT add dollar/amount/Stripe logic until
 * Phase 2 billing is reviewed and approved.
 */
export interface BalanceSeam {
  check(req: BalanceCheckRequest): Promise<BalanceCheckResult>;
}

/**
 * stubBalanceSeam — the ALWAYS-OK Phase 1 balance seam.
 *
 * [VERIFY-3c-MONEY] This stub is a no-op. It performs NO I/O, NO Stripe call,
 * NO database read, NO money computation. It ALWAYS returns `{ ok: true }`.
 * Replacing this stub with a real implementation is a Phase 2 concern.
 */
export const stubBalanceSeam: BalanceSeam = {
  // [VERIFY-3c-MONEY] Always returns {ok:true}. Never returns below_minimum.
  // No Stripe/payment/card/dollar/minimum/invoicing. Phase 1 money boundary.
  async check(_req: BalanceCheckRequest): Promise<BalanceCheckResult> {
    return { ok: true };
  },
};
