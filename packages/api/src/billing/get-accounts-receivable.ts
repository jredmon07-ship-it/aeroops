/**
 * billing/get-accounts-receivable.ts — getAccountsReceivable (Financial/AR
 * reporting slice).
 *
 * Per-member outstanding balance, aged into 5 buckets (current / 1-30 / 31-60
 * / 61-90 / 90+ days), plus org-level totals. READ-ONLY aggregate over the
 * EXISTING billing tables (billing_account, ledger_entry, app_user) — NO new
 * migration, NO schema change.
 *
 * ── METRIC DEFINITION (pin here — two people must compute the same number) ──
 *
 * balanceCents (per member) = Σ(credit amount_cents) − Σ(debit amount_cents)
 *   over every ledger_entry row for that member's billing_account. Same sign
 *   convention as @aeroops/core's `computeBalance` (a positive balance means
 *   the member has funds on account; this report only lists members whose
 *   balance is NEGATIVE of that convention, i.e. they OWE money — see below).
 *
 * "Owes money" filter: a member appears in the AR list iff
 *   Σ(debit) − Σ(credit) > 0  (equivalently: computeBalance's sign is negative).
 *   This report's `balanceCents` field is reported as that POSITIVE owed
 *   amount (Σdebit − Σcredit), NOT the raw computeBalance sign — i.e.
 *   `balanceCents` here = money owed BY the member TO the operator.
 *   A member with a zero or CREDIT balance (they don't owe anything, or the
 *   operator owes them / they've prepaid) is EXCLUDED from this report
 *   entirely (HAVING clause) — never shown as a negative/zero AR row.
 *
 * Aging reference date [VERIFY-AR-AGING-1]: this system has no per-invoice
 * payment ALLOCATION (a 'payment' credit reduces the whole account, not one
 * invoice) — so "age of the oldest unpaid invoice" is approximated as the
 * EARLIEST 'invoice_finalized' ledger_entry.created_at for that account (the
 * date the member's obligation to the operator began). If a member owes money
 * with NO invoice_finalized entry at all (e.g. a manual 'adjustment' debit —
 * a forward seam not yet written by any command), the reference date falls
 * back to the earliest 'debit' entry of any type, then to the earliest ledger
 * entry of any kind, then (only if truly none, which should be unreachable
 * given a positive balance) to `asOf` ('current').
 *
 * Bucketing itself is @aeroops/core's `bucketAgingItem`/`aggregateAging` —
 * see billing/ar-aging.ts for the exact day-boundary rule.
 *
 * AUTHZ: requireCapability('billing:access') FIRST — NOT reporting:access
 *   (reporting:access is broader: dispatcher/cfi also hold it, and this is
 *   MONEY data; billing:access is owner/manager/accountant only — the correct,
 *   narrower scope for a financial report).
 * TENANT ISOLATION: org_id from session only (withSessionOrgContextWithDb);
 *   billing_account/ledger_entry/app_user are all RLS-scoped by the GUC — no
 *   additional org_id predicate needed (mirrors the house convention
 *   documented in reporting/get-hours-by-tail.ts and billing/ledger-internal.ts).
 * READ-ONLY: zero writes, zero audit rows.
 * MONEY: integer cents throughout; NO float in the money path.
 *
 * TWO CALLING FORMS:
 *   getAccountsReceivable(session)          — app code.
 *   getAccountsReceivableWithDb(db, session) — tests.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { aggregateAging } from '@aeroops/core';
import type { AgingBuckets, AgingItem } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { extractRows } from '../db-rows.js';

// ─── Output types ─────────────────────────────────────────────────────────────

export interface AccountsReceivableRow {
  memberUserId: string;
  memberName: string;
  /** Amount owed BY the member TO the operator, in integer cents. Always > 0. */
  balanceCents: number;
  aging: AgingBuckets;
}

export interface AccountsReceivableResult {
  /** The instant this snapshot was computed (point-in-time, not a range). */
  asOf: Date;
  rows: AccountsReceivableRow[];
  /** Org-level bucket totals — Σ across every row. */
  totals: AgingBuckets;
  /** Σ of every row's balanceCents — equals Σ of the 5 totals fields. */
  totalOutstandingCents: number;
}

// ─── Row shape from the raw query ─────────────────────────────────────────────

interface RawRow {
  memberUserId: string;
  memberFullName: string | null;
  memberEmail: string;
  balanceCents: number | string;
  oldestInvoiceFinalizedAt: Date | string | null;
  oldestDebitAt: Date | string | null;
  oldestEntryAt: Date | string | null;
}

function parseNullableDate(v: Date | string | null): Date | null {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getAccountsReceivableImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<AccountsReceivableResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:access');

  // 2. Point-in-time snapshot — "now" computed once, used for every row's aging.
  const asOf = new Date();

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // ONE query: billing_account JOIN app_user LEFT JOIN ledger_entry, grouped
    // per member. HAVING keeps only members who currently owe money (Σdebit −
    // Σcredit > 0) — a credit or zero balance is excluded entirely, never
    // shown as a zero/negative AR row.
    //
    // Tenant isolation: billing_account, app_user, ledger_entry are all
    // RLS-scoped to the session org by the GUC (FORCE RLS) — the JOINs can
    // never surface a cross-org row; no org_id predicate needed (mirrors
    // get-hours-by-tail.ts's documented "subtlest spot" convention).
    const result = await tx.execute(sql`
      SELECT
        ba.user_id                                                                 AS "memberUserId",
        u.full_name                                                                AS "memberFullName",
        u.email                                                                    AS "memberEmail",
        COALESCE(SUM(CASE WHEN le.direction = 'debit' THEN le.amount_cents
                          WHEN le.direction = 'credit' THEN -le.amount_cents
                          ELSE 0 END), 0)::int                                     AS "balanceCents",
        MIN(le.created_at) FILTER (WHERE le.entry_type = 'invoice_finalized')      AS "oldestInvoiceFinalizedAt",
        MIN(le.created_at) FILTER (WHERE le.direction = 'debit')                   AS "oldestDebitAt",
        MIN(le.created_at)                                                        AS "oldestEntryAt"
      FROM billing_account ba
      JOIN app_user u ON u.id = ba.user_id
      LEFT JOIN ledger_entry le ON le.account_id = ba.id
      GROUP BY ba.user_id, u.full_name, u.email
      HAVING COALESCE(SUM(CASE WHEN le.direction = 'debit' THEN le.amount_cents
                                WHEN le.direction = 'credit' THEN -le.amount_cents
                                ELSE 0 END), 0) > 0
      ORDER BY "balanceCents" DESC, u.full_name ASC NULLS LAST
    `);

    const rawRows = extractRows<RawRow>(result);

    const rows: AccountsReceivableRow[] = rawRows.map((r) => {
      const referenceDate =
        parseNullableDate(r.oldestInvoiceFinalizedAt) ??
        parseNullableDate(r.oldestDebitAt) ??
        parseNullableDate(r.oldestEntryAt) ??
        asOf;

      const item: AgingItem = {
        balanceCents: Number(r.balanceCents),
        asOf,
        referenceDate,
      };
      const { buckets, totalCents } = aggregateAging([item]);

      return {
        memberUserId: r.memberUserId,
        memberName: r.memberFullName ?? r.memberEmail,
        balanceCents: totalCents,
        aging: buckets,
      };
    });

    // Org totals = an exact Σ of each row's already-bucketed aging (every row
    // keeps its own age — this is NOT a re-aggregation against a shared
    // referenceDate, which would discard the per-member aging distinction).
    const totals: AgingBuckets = rows.reduce(
      (acc, r) => ({
        current: acc.current + r.aging.current,
        d30: acc.d30 + r.aging.d30,
        d60: acc.d60 + r.aging.d60,
        d90: acc.d90 + r.aging.d90,
        d90plus: acc.d90plus + r.aging.d90plus,
      }),
      { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 },
    );
    const totalOutstandingCents = rows.reduce((acc, r) => acc + r.balanceCents, 0);

    return {
      asOf,
      rows,
      totals,
      totalOutstandingCents,
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getAccountsReceivable(
  session: AppSession | null | undefined,
): Promise<AccountsReceivableResult> {
  const db = await getDb();
  return _getAccountsReceivableImpl(db, session);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getAccountsReceivableWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<AccountsReceivableResult> {
  return _getAccountsReceivableImpl(db, session);
}
