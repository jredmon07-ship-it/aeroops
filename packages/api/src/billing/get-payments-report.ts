/**
 * billing/get-payments-report.ts — getPaymentsReport (FC canned-report menu).
 *
 * Every 'payment' ledger_entry posted over a rolling UTC range, one row each:
 * date, member, amount, and a payment reference (paymentId ?? memo), plus
 * period totals. READ-ONLY aggregate over EXISTING billing tables
 * (ledger_entry, billing_account, app_user) — NO new migration, NO schema
 * change.
 *
 * ── METRIC DEFINITION (pin here — two people must compute the same number) ──
 *
 * A row is emitted for every ledger_entry WHERE entry_type = 'payment'
 *   AND created_at IN [from, to) (half-open). 'payment' entries are always a
 *   'credit' (they RAISE the member's balance) — either a manual operator
 *   entry (recordManualPayment) or a Stripe-webhook-verified credit (Slice B3).
 *   amountCents is the positive credit magnitude (ledger amounts are always a
 *   positive integer; direction carries the sign — see ledger_entry schema).
 *
 * totalPaymentCents = Σ amountCents across every row in the window. Integer cents.
 * paymentCount      = number of payment entries in the window.
 *
 * reference: the operator's free-text payment reference. `paymentId` is a
 *   manual note OR a Stripe PaymentIntent id (Slice B3); `memo` is a separate
 *   free-text note. Both are surfaced raw — the display layer chooses
 *   paymentId ?? memo. NEVER a raw card/bank instrument (money-boundary note in
 *   the ledger_entry schema).
 *
 * AUTHZ: requireCapability('billing:access') FIRST — this is MONEY data
 *   (owner/manager/accountant), mirrors get-revenue-report.
 * TENANT ISOLATION: org_id from session only (withSessionOrgContextWithDb);
 *   ledger_entry + billing_account + app_user are all RLS-scoped by the GUC —
 *   no additional org_id predicate needed (house convention, see
 *   get-accounts-receivable.ts).
 * READ-ONLY: zero writes, zero audit rows.
 * MONEY: integer cents throughout; NO float in the money path.
 *
 * [VERIFY] OPERATIONAL payment reporting — NOT a tax/GAAP/audit determination.
 *
 * TWO CALLING FORMS:
 *   getPaymentsReport(session, input)          — app code.
 *   getPaymentsReportWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { resolveReportRange } from '../reporting/internal.js';
import type { ReportRangeKey } from '../reporting/internal.js';
import { extractRows } from '../db-rows.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const ReportRangeKeySchema = z.enum(['7d', '30d', '90d', '180d', '365d']).default('30d');
const InputSchema = z.object({ range: ReportRangeKeySchema });

export type GetPaymentsReportInput = { range?: ReportRangeKey | string };

// ─── Output types ─────────────────────────────────────────────────────────────

export interface PaymentReportRow {
  entryId: string;
  createdAt: Date;
  memberUserId: string;
  memberName: string;
  /** Positive payment-credit magnitude. Integer cents. */
  amountCents: number;
  /** Stripe PaymentIntent id or an operator's free-text reference. */
  paymentId: string | null;
  /** Operator free-text note. */
  memo: string | null;
}

export interface PaymentsReportResult {
  range: { key: ReportRangeKey; from: Date; to: Date };
  rows: PaymentReportRow[];
  /** Σ amountCents across every row. Integer cents. */
  totalPaymentCents: number;
  /** Number of payment entries in the window. */
  paymentCount: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetPaymentsReportInput,
): Promise<PaymentsReportResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:access');

  // 2. Validate range.
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(`Invalid range: ${parsed.error.message}`);
  const rangeKey = parsed.data.range as ReportRangeKey;

  // 3. Resolve window.
  const now = new Date();
  const { from, to } = resolveReportRange(rangeKey, now);
  // In raw sql`` templates, from/to are bound as ISO strings with an explicit
  // ::timestamptz cast (postgres-js cannot serialize a JS Date to db.execute()).

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // ledger_entry (payment) JOIN billing_account JOIN app_user for the member
    // name. RLS scopes every table to this org — no org_id predicate needed.
    const queryResult = await tx.execute(sql`
      SELECT
        le.id                          AS "entryId",
        le.created_at                  AS "createdAt",
        ba.user_id                     AS "memberUserId",
        COALESCE(u.full_name, u.email) AS "memberName",
        le.amount_cents                AS "amountCents",
        le.payment_id                  AS "paymentId",
        le.memo                        AS "memo"
      FROM ledger_entry le
      JOIN billing_account ba ON ba.id = le.account_id
      JOIN app_user u ON u.id = ba.user_id
      WHERE le.entry_type = 'payment'
        AND le.created_at >= ${from.toISOString()}::timestamptz
        AND le.created_at <  ${to.toISOString()}::timestamptz
      ORDER BY le.created_at DESC
    `);

    const rawRows = extractRows<{
      entryId: string;
      createdAt: Date | string;
      memberUserId: string;
      memberName: string;
      amountCents: number | string;
      paymentId: string | null;
      memo: string | null;
    }>(queryResult);

    let totalPaymentCents = 0;
    const rows: PaymentReportRow[] = rawRows.map((r) => {
      const amountCents = Number(r.amountCents ?? 0);
      totalPaymentCents += amountCents;
      return {
        entryId: r.entryId,
        createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
        memberUserId: r.memberUserId,
        memberName: r.memberName,
        amountCents,
        paymentId: r.paymentId,
        memo: r.memo,
      };
    });

    return {
      range: { key: rangeKey, from, to },
      rows,
      totalPaymentCents,
      paymentCount: rows.length,
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getPaymentsReport(
  session: AppSession | null | undefined,
  rawInput: GetPaymentsReportInput = {},
): Promise<PaymentsReportResult> {
  const db = await getDb();
  return _impl(db, session, rawInput);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getPaymentsReportWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetPaymentsReportInput = {},
): Promise<PaymentsReportResult> {
  return _impl(db, session, rawInput);
}
