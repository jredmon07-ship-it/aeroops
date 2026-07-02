/**
 * billing/ledger-math.ts — pure ledger balance arithmetic (the @aeroops/core
 * half of Slice B2).
 *
 * No I/O, no Drizzle, no React, no clock, no randomness, NO Stripe, NO
 * card/bank anything. This is PURE ARITHMETIC over a caller-supplied list of
 * append-only ledger entries.
 *
 * MONEY = INTEGER CENTS. Every `amountCents` is a whole, POSITIVE number of
 * cents. The sign of a movement is carried by `direction` ('debit' |
 * 'credit'), never by a negative amount — this mirrors the DB schema
 * (ledger_entry.amount_cents CHECK > 0, migration 0022) exactly, so the
 * pure function and the persisted rows can never disagree about sign
 * representation.
 *
 * SIGN CONVENTION (load-bearing — pin here):
 *   balance = Σ(credit amounts) − Σ(debit amounts)
 *
 *   'credit' entries RAISE the balance available to a member — e.g. a
 *     'payment' (the member paid money in) or a 'credit_memo' (an operator
 *     credit/refund acknowledgement).
 *   'debit' entries LOWER the balance — e.g. an 'invoice_finalized' entry
 *     (the member now owes the operator for that invoice) or a debit-
 *     direction 'adjustment'.
 *
 * This is the "prepaid / minimum-balance" mental model an FBO/flight-school
 * operator uses: a positive balance means the member has funds/credit on
 * account; a balance below the operator's configured minimum (Slice B2's
 * `dispatch_config.minimum_balance_cents`, read by `realBalanceSeam`) means
 * the member should top up before flying again. A negative balance is a
 * legitimate result (the member owes money) — this function does NOT clamp.
 *
 * PART OF: Phase-2 B2 (ledger + balance, NO Stripe, gate stays OFF). Consumed
 * by packages/api/src/billing/real-balance-seam.ts (NOT injected into the
 * FROZEN openDispatch() app-code path in this slice).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single ledger entry as seen by `computeBalance`.
 *
 * Mirrors the persisted `ledger_entry` row's money-relevant columns exactly:
 * `amountCents` is always a non-negative* integer (see precondition below);
 * `direction` carries the sign.
 *
 * (*) `computeBalance` validates `amountCents > 0` at the boundary — a
 * zero/negative amount is a caller bug (the DB CHECK already forbids it for
 * persisted rows; this guard catches the same class of bug for in-memory
 * callers, e.g. property tests exploring adversarial inputs).
 */
export interface LedgerEntryAmount {
  readonly direction: 'debit' | 'credit';
  /** Always a positive integer, in cents. */
  readonly amountCents: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * computeBalance — sum a list of ledger entries into a single balance, in
 * INTEGER CENTS.
 *
 * balance = Σ(credit amounts) − Σ(debit amounts)
 *
 * DETERMINISTIC + ORDER-INDEPENDENT: the result depends only on the
 * multiset of (direction, amountCents) pairs, never on array order — this
 * is the "append-only ledger" invariant: replaying the same set of entries
 * in any order (e.g. after a re-fetch, or a differently-ordered DB scan)
 * must always produce the same balance.
 *
 * ZERO-ENTRY EDGE: an empty `entries` array returns 0.
 *
 * @param entries  Append-only ledger entries (order-independent). Each
 *                 `amountCents` must be a positive integer. The function
 *                 validates and throws on violation (never silently
 *                 tolerates a malformed entry in audit-grade money code).
 * @returns the balance, in integer cents. May be negative (the member owes
 *          money) — this function does NOT clamp.
 * @throws RangeError if any `amountCents` is non-positive, non-finite, or
 *                     non-integer, or if `direction` is not 'debit'/'credit'.
 */
export function computeBalance(
  entries: ReadonlyArray<LedgerEntryAmount>,
): number {
  let balance = 0;
  for (const entry of entries) {
    if (
      !Number.isFinite(entry.amountCents) ||
      !Number.isInteger(entry.amountCents) ||
      entry.amountCents <= 0
    ) {
      throw new RangeError(
        `computeBalance: amountCents must be a positive integer, got ${entry.amountCents}`,
      );
    }
    if (entry.direction === 'credit') {
      balance += entry.amountCents;
    } else if (entry.direction === 'debit') {
      balance -= entry.amountCents;
    } else {
      throw new RangeError(
        `computeBalance: direction must be 'debit' or 'credit', got ${String(entry.direction)}`,
      );
    }
  }
  return balance;
}
