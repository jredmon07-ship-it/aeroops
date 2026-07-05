/**
 * billing/get-member-block-summary.ts — getMemberBlockSummary (Slice B4).
 * STAFF view (billing:access) — NOT the portal self-view (see
 * portal/get-my-block-summary.ts for that).
 *
 * For ONE member: total hours purchased, total amount purchased (cents),
 * their current prepaid balance, and their block-purchase history
 * (newest first). READ-ONLY aggregate over EXISTING + new B4 tables
 * (block_purchase, billing_account, ledger_entry) — the aggregation itself
 * is the pure, property-tested `aggregateBlockPurchases` (@aeroops/core).
 *
 * ── METRIC DEFINITIONS (pin here) ─────────────────────────────────────────
 *
 * totalHoursPurchased / totalAmountPurchasedCents = Σ across every
 *   block_purchase row for this member (aggregateBlockPurchases). This is a
 *   PURCHASE total — it does NOT subtract any hours flown (see v1 scope note
 *   below).
 *
 * prepaidBalanceCents = max(0, computeBalance(member's ledger entries)). The
 *   member's derived ledger balance (@aeroops/core computeBalance) already
 *   nets 'block_purchase'/'payment' credits against 'invoice_finalized'
 *   debits — a positive balance IS the remaining prepaid credit. A member
 *   who owes money (negative balance) shows 0 here, never a negative
 *   "prepaid balance" (the AR report is the correct surface for money owed).
 *
 * [DEFERRED — v1, see docs/specs/slice-b4-block-time.md]: this module does
 * NOT build a per-flight hours-based discounted-rate DRAWDOWN — "hours
 * remaining" in v1 is approximated ONLY via the derived ledger balance
 * dollar amount, not a separate hours meter. A future slice may subtract
 * flown hours from totalHoursPurchased directly; that is explicitly out of
 * scope here.
 *
 * AUTHZ: requireCapability('billing:access') FIRST.
 * TENANT ISOLATION: memberUserId must be a member of the session's org
 *   (membership check, mirrors get-member-statement.ts) — a cross-org id
 *   returns { ok:false, reason:'not_found' }, never a cross-org read.
 * READ-ONLY: zero writes, zero audit rows.
 * MONEY: integer cents throughout; NO float in the money path.
 *
 * TWO CALLING FORMS:
 *   getMemberBlockSummary(session, input)          — app code.
 *   getMemberBlockSummaryWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { membership, appUser } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { computeBalance, aggregateBlockPurchases } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { findBillingAccountTx, loadLedgerEntryAmountsTx } from './ledger-internal.js';
import { loadBlockPurchasesTx } from './block-time-internal.js';
import type { BlockPurchaseView } from './block-time-internal.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const getMemberBlockSummaryInputSchema = z.object({
  memberId: z.string().regex(UUID_RE, { message: 'memberId must be a UUID' }),
});

export type GetMemberBlockSummaryInput = { memberId: string };

// ─── Output types ─────────────────────────────────────────────────────────────

export interface MemberBlockSummary {
  memberUserId: string;
  memberName: string;
  totalHoursPurchased: number;
  totalAmountPurchasedCents: number;
  /** max(0, derived ledger balance) — the member's remaining prepaid credit. */
  prepaidBalanceCents: number;
  /** Newest-first purchase history. */
  purchases: BlockPurchaseView[];
}

export type GetMemberBlockSummaryResult =
  | { ok: true; summary: MemberBlockSummary }
  | { ok: false; reason: 'not_found' };

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetMemberBlockSummaryInput,
): Promise<GetMemberBlockSummaryResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:access');

  // 2. VALIDATE input.
  const parsed = getMemberBlockSummaryInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid getMemberBlockSummary input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { memberId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // memberId must be a member of THIS org — RLS also backstops this
    // (membership rows are org-scoped); an explicit check gives a clean
    // not_found instead of a silently-empty summary.
    const memberRows = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(and(eq(membership.userId, memberId), eq(membership.orgId, sess.orgId)))
      .limit(1);
    if (!memberRows[0]) {
      return { ok: false, reason: 'not_found' } as const;
    }

    // Member display name (fullName ?? email — mirrors get-member-statement.ts).
    const nameRows = await tx
      .select({ fullName: appUser.fullName, email: appUser.email })
      .from(appUser)
      .where(eq(appUser.id, memberId))
      .limit(1);
    const nameRow = nameRows[0];
    const memberName = nameRow?.fullName ?? nameRow?.email ?? memberId;

    // Purchase history + purchase totals (pure aggregator, @aeroops/core).
    const purchases = await loadBlockPurchasesTx(tx, sess.orgId, memberId);
    const totals = aggregateBlockPurchases(
      purchases.map((p) => ({ hours: p.hours, amountCents: p.amountCents })),
    );

    // Prepaid balance = max(0, derived ledger balance).
    const accountId = await findBillingAccountTx(tx, sess.orgId, memberId);
    const entries = accountId ? await loadLedgerEntryAmountsTx(tx, accountId) : [];
    const balanceCents = computeBalance(entries);
    const prepaidBalanceCents = Math.max(0, balanceCents);

    return {
      ok: true,
      summary: {
        memberUserId: memberId,
        memberName,
        totalHoursPurchased: totals.totalHours,
        totalAmountPurchasedCents: totals.totalAmountCents,
        prepaidBalanceCents,
        purchases,
      },
    } as const;
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getMemberBlockSummary(
  session: AppSession | null | undefined,
  input: GetMemberBlockSummaryInput,
): Promise<GetMemberBlockSummaryResult> {
  const db = await getDb();
  return _impl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getMemberBlockSummaryWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetMemberBlockSummaryInput,
): Promise<GetMemberBlockSummaryResult> {
  return _impl(db, session, input);
}
