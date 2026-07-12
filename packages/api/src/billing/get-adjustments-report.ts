/**
 * billing/get-adjustments-report.ts — getAdjustmentsReport (FC canned-report menu).
 *
 * Every billing-correction ledger_entry ('credit_memo' or 'adjustment') posted
 * over a rolling UTC range, one row each: date, member, type, direction,
 * amount, memo, and WHO posted it — plus period totals split by direction.
 * READ-ONLY aggregate over EXISTING billing tables (ledger_entry,
 * billing_account, app_user) — NO new migration, NO schema change.
 *
 * ── METRIC DEFINITION (pin here — two people must compute the same number) ──
 *
 * A row is emitted for every ledger_entry WHERE
 *   entry_type IN ('credit_memo','adjustment')
 *   AND created_at IN [from, to) (half-open).
 *   - 'credit_memo' is always a CREDIT (a correction in the member's favor —
 *     issueCreditMemo).
 *   - 'adjustment' is either direction (issueAdjustment — 'debit' lowers, a
 *     'credit' raises the member's balance).
 *   amountCents is the positive magnitude (ledger amounts are always positive;
 *   `direction` carries the sign — see ledger_entry schema).
 *   createdByName is the operator who posted it (COALESCE full_name/email); NULL
 *   for a SYSTEM-generated entry (created_by IS NULL — mirrors audit_log).
 *
 * totalCreditCents = Σ amountCents WHERE direction = 'credit'. Integer cents.
 * totalDebitCents  = Σ amountCents WHERE direction = 'debit'.  Integer cents.
 * count            = number of correction entries in the window.
 *
 * AUTHZ: requireCapability('billing:access') FIRST — MONEY data
 *   (owner/manager/accountant), mirrors get-revenue-report.
 * TENANT ISOLATION: org_id from session only (withSessionOrgContextWithDb);
 *   ledger_entry + billing_account + app_user are RLS-scoped by the GUC — no
 *   additional org_id predicate needed (house convention).
 * READ-ONLY: zero writes, zero audit rows.
 * MONEY: integer cents throughout; NO float in the money path.
 *
 * [VERIFY] OPERATIONAL correction reporting — NOT a tax/GAAP/audit determination.
 *
 * TWO CALLING FORMS:
 *   getAdjustmentsReport(session, input)          — app code.
 *   getAdjustmentsReportWithDb(db, session, input) — tests.
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

export type GetAdjustmentsReportInput = { range?: ReportRangeKey | string };

// ─── Output types ─────────────────────────────────────────────────────────────

export interface AdjustmentReportRow {
  entryId: string;
  createdAt: Date;
  memberUserId: string;
  memberName: string;
  entryType: 'credit_memo' | 'adjustment';
  direction: 'debit' | 'credit';
  /** Positive magnitude. Integer cents. */
  amountCents: number;
  memo: string | null;
  /** Operator who posted it; null for a SYSTEM entry. */
  createdByName: string | null;
}

export interface AdjustmentsReportResult {
  range: { key: ReportRangeKey; from: Date; to: Date };
  rows: AdjustmentReportRow[];
  /** Σ amountCents for credit-direction rows. Integer cents. */
  totalCreditCents: number;
  /** Σ amountCents for debit-direction rows. Integer cents. */
  totalDebitCents: number;
  /** Number of correction entries in the window. */
  count: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetAdjustmentsReportInput,
): Promise<AdjustmentsReportResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:access');

  // 2. Validate range.
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(`Invalid range: ${parsed.error.message}`);
  const rangeKey = parsed.data.range as ReportRangeKey;

  // 3. Resolve window.
  const now = new Date();
  const { from, to } = resolveReportRange(rangeKey, now);
  // from/to bound as ISO strings with ::timestamptz (postgres-js can't take a Date).

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // ledger_entry (correction) JOIN billing_account JOIN app_user (member),
    // LEFT JOIN app_user (creator) — creator is nullable for SYSTEM entries.
    // RLS scopes every table to this org — no org_id predicate needed.
    const queryResult = await tx.execute(sql`
      SELECT
        le.id                          AS "entryId",
        le.created_at                  AS "createdAt",
        ba.user_id                     AS "memberUserId",
        COALESCE(u.full_name, u.email) AS "memberName",
        le.entry_type                  AS "entryType",
        le.direction                   AS "direction",
        le.amount_cents                AS "amountCents",
        le.memo                        AS "memo",
        COALESCE(c.full_name, c.email) AS "createdByName"
      FROM ledger_entry le
      JOIN billing_account ba ON ba.id = le.account_id
      JOIN app_user u ON u.id = ba.user_id
      LEFT JOIN app_user c ON c.id = le.created_by
      WHERE le.entry_type IN ('credit_memo', 'adjustment')
        AND le.created_at >= ${from.toISOString()}::timestamptz
        AND le.created_at <  ${to.toISOString()}::timestamptz
      ORDER BY le.created_at DESC
    `);

    const rawRows = extractRows<{
      entryId: string;
      createdAt: Date | string;
      memberUserId: string;
      memberName: string;
      entryType: string;
      direction: string;
      amountCents: number | string;
      memo: string | null;
      createdByName: string | null;
    }>(queryResult);

    let totalCreditCents = 0;
    let totalDebitCents = 0;
    const rows: AdjustmentReportRow[] = rawRows.map((r) => {
      const amountCents = Number(r.amountCents ?? 0);
      const direction = r.direction === 'debit' ? 'debit' : 'credit';
      if (direction === 'credit') totalCreditCents += amountCents;
      else totalDebitCents += amountCents;
      return {
        entryId: r.entryId,
        createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
        memberUserId: r.memberUserId,
        memberName: r.memberName,
        entryType: r.entryType === 'credit_memo' ? 'credit_memo' : 'adjustment',
        direction,
        amountCents,
        memo: r.memo,
        createdByName: r.createdByName,
      };
    });

    return {
      range: { key: rangeKey, from, to },
      rows,
      totalCreditCents,
      totalDebitCents,
      count: rows.length,
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getAdjustmentsReport(
  session: AppSession | null | undefined,
  rawInput: GetAdjustmentsReportInput = {},
): Promise<AdjustmentsReportResult> {
  const db = await getDb();
  return _impl(db, session, rawInput);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getAdjustmentsReportWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetAdjustmentsReportInput = {},
): Promise<AdjustmentsReportResult> {
  return _impl(db, session, rawInput);
}
