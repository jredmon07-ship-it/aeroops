/**
 * portal/get-my-block-summary.ts — getMyBlockSummary (Slice B4).
 *
 * SELF-SCOPED (portal:access): the caller's OWN block-time (prepaid package)
 * summary — own purchase totals, own prepaid balance, own purchase history.
 * Mirrors the portal/get-my-billing.ts pattern EXACTLY (no row-identifying
 * input; subject is always session.userId) — resolves the same self-scoping
 * guarantee for block-time that P0-REV already resolved for billing.
 *
 * Shares its aggregation logic with the STAFF view
 * (billing/get-member-block-summary.ts) via billing/block-time-internal.ts's
 * loadBlockPurchasesTx, so the two surfaces can never compute a different
 * number for the same member.
 *
 * GUARANTEES:
 *   - authz FIRST: portal:access before any data access.
 *   - org_id + subject from session only (withSessionOrgContextWithDb).
 *   - READ-ONLY: zero writes, zero audit rows.
 *   - NO cross-member data — memberUserId is never a caller input.
 *
 * TWO CALLING FORMS:
 *   getMyBlockSummary(session)          — app code.
 *   getMyBlockSummaryWithDb(db, session) — tests.
 */
import { computeBalance, aggregateBlockPurchases } from '@aeroops/core';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { findBillingAccountTx, loadLedgerEntryAmountsTx } from '../billing/ledger-internal.js';
import { loadBlockPurchasesTx } from '../billing/block-time-internal.js';
import type { BlockPurchaseView } from '../billing/block-time-internal.js';

export interface MyBlockSummary {
  totalHoursPurchased: number;
  totalAmountPurchasedCents: number;
  /** max(0, derived ledger balance) — the member's remaining prepaid credit. */
  prepaidBalanceCents: number;
  /** Newest-first purchase history. */
  purchases: BlockPurchaseView[];
}

async function _getMyBlockSummaryImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<MyBlockSummary> {
  requireCapability(session, 'portal:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const purchases = await loadBlockPurchasesTx(tx, sess.orgId, sess.userId);
    const totals = aggregateBlockPurchases(
      purchases.map((p) => ({ hours: p.hours, amountCents: p.amountCents })),
    );

    const accountId = await findBillingAccountTx(tx, sess.orgId, sess.userId);
    const entries = accountId ? await loadLedgerEntryAmountsTx(tx, accountId) : [];
    const balanceCents = computeBalance(entries);
    const prepaidBalanceCents = Math.max(0, balanceCents);

    return {
      totalHoursPurchased: totals.totalHours,
      totalAmountPurchasedCents: totals.totalAmountCents,
      prepaidBalanceCents,
      purchases,
    };
  });
}

export async function getMyBlockSummary(session: AppSession | null | undefined): Promise<MyBlockSummary> {
  const db = await getDb();
  return _getMyBlockSummaryImpl(db, session);
}

export async function getMyBlockSummaryWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<MyBlockSummary> {
  return _getMyBlockSummaryImpl(db, session);
}
