/**
 * billing/ledger-internal.ts — shared internals for the billing ledger
 * (Slice B2). NOT barrel-exported from @aeroops/api.
 *
 * All helpers here run on an ALREADY-OPEN, already org-scoped transaction
 * (the caller has already applied withSessionOrgContextWithDb / withOrgContext
 * — these helpers NEVER set org context themselves, mirroring dispatch-gate/
 * internal.ts's convention). RLS is the enforcement backstop for every read
 * here — no explicit org_id predicate is added to WHERE clauses beyond what
 * a composite-key lookup already needs, matching the house convention (see
 * reporting/get-hours-by-tail.ts's tenant-isolation comment).
 *
 * Holds:
 *   - ensureBillingAccountTx — lazily creates (or finds) the billing_account
 *     row for (orgId, userId). INSERT ... ON CONFLICT (org_id, user_id) DO
 *     NOTHING, then a fallback SELECT — race-safe under the UNIQUE index
 *     (migration 0022 billing_account_org_user_unique).
 *   - findBillingAccountTx — READ-ONLY lookup; returns null if the member
 *     has never had a billing_account row (no ledger activity yet).
 *   - loadLedgerEntryAmountsTx — reads (direction, amountCents) pairs for an
 *     account, the exact shape `computeBalance` (@aeroops/core) consumes.
 */

import { eq, and } from 'drizzle-orm';
import { billingAccount, ledgerEntry } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import type { LedgerEntryAmount } from '@aeroops/core';

// ─── ensureBillingAccountTx ───────────────────────────────────────────────────

/**
 * ensureBillingAccountTx — lazily creates (or finds) the billing_account row
 * for (orgId, userId). Race-safe: a concurrent creator wins the UNIQUE index
 * and this call falls through to the SELECT.
 */
export async function ensureBillingAccountTx(
  tx: AnyDb,
  orgId: string,
  userId: string,
): Promise<string> {
  const inserted = await tx
    .insert(billingAccount)
    .values({ orgId, userId })
    .onConflictDoNothing({ target: [billingAccount.orgId, billingAccount.userId] })
    .returning({ id: billingAccount.id });

  if (inserted[0]) return inserted[0].id;

  const existing = await tx
    .select({ id: billingAccount.id })
    .from(billingAccount)
    .where(and(eq(billingAccount.orgId, orgId), eq(billingAccount.userId, userId)))
    .limit(1);

  const row = existing[0];
  if (!row) {
    // Unreachable under normal operation: ON CONFLICT DO NOTHING firing
    // implies a concurrent insert won the UNIQUE index, so a row MUST exist.
    // Guarded explicitly rather than silently returning undefined in
    // audit-grade money code.
    throw new Error(
      `[billing] ensureBillingAccountTx: no billing_account row found for org=${orgId} user=${userId} after insert/conflict`,
    );
  }
  return row.id;
}

// ─── findBillingAccountTx ─────────────────────────────────────────────────────

/**
 * findBillingAccountTx — READ-ONLY lookup. Returns null when the member has
 * never had a billing_account row (i.e. no ledger activity has ever been
 * posted for them) — callers treat this as an empty ledger / zero balance,
 * NOT an error.
 */
export async function findBillingAccountTx(
  tx: AnyDb,
  orgId: string,
  userId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ id: billingAccount.id })
    .from(billingAccount)
    .where(and(eq(billingAccount.orgId, orgId), eq(billingAccount.userId, userId)))
    .limit(1);
  return rows[0]?.id ?? null;
}

// ─── loadLedgerEntryAmountsTx ─────────────────────────────────────────────────

/**
 * loadLedgerEntryAmountsTx — reads every ledger_entry row for an account, in
 * the exact (direction, amountCents) shape `computeBalance` (@aeroops/core)
 * consumes. Order does not matter (computeBalance is order-independent).
 */
export async function loadLedgerEntryAmountsTx(
  tx: AnyDb,
  accountId: string,
): Promise<LedgerEntryAmount[]> {
  const rows = await tx
    .select({ direction: ledgerEntry.direction, amountCents: ledgerEntry.amountCents })
    .from(ledgerEntry)
    .where(eq(ledgerEntry.accountId, accountId));
  return rows.map((r) => ({
    direction: r.direction as 'debit' | 'credit',
    amountCents: r.amountCents,
  }));
}
