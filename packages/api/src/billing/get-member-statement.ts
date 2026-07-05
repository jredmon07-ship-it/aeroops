/**
 * billing/get-member-statement.ts — getMemberStatement (Financial/AR reporting
 * slice). STAFF view (billing:access) — NOT the portal self-view.
 *
 * Combines, for ONE member: their invoices (status + totals) and their
 * complete ledger history in CHRONOLOGICAL (oldest-first) order with a
 * running balance computed after each entry. READ-ONLY aggregate over
 * EXISTING billing tables (invoice, billing_account, ledger_entry, app_user)
 * — NO new migration, NO schema change.
 *
 * ── METRIC DEFINITION ──────────────────────────────────────────────────────
 *
 * runningBalanceCents (per ledger row, in ascending created_at,id order) =
 *   Σ(credit amountCents) − Σ(debit amountCents) over every entry UP TO AND
 *   INCLUDING this one. Same sign convention as @aeroops/core's
 *   `computeBalance` — a positive running balance means the member has funds
 *   on account at that point in time; the LAST row's runningBalanceCents ===
 *   the member's current derived balance (identical to what getMemberBalance
 *   returns).
 *
 * invoices: every invoice row for this member (draft/finalized/void), newest
 *   first — same view shape (`InvoiceView`) as list-invoices.ts.
 *
 * AUTHZ: requireCapability('billing:access') FIRST — this is the STAFF
 *   statement view (an accountant/owner/manager looking up a member's
 *   account), distinct from the member's own self-service portal view
 *   (portal:access, a separate surface — not built or touched here).
 * TENANT ISOLATION: memberUserId must be a member of the session's org
 *   (membership check, mirrors ledger-account.ts) — a cross-org id returns
 *   { ok:false, reason:'not_found' }, never a cross-org read. RLS is the
 *   backstop underneath every table touched.
 * READ-ONLY: zero writes, zero audit rows.
 * MONEY: integer cents throughout; NO float in the money path.
 *
 * TWO CALLING FORMS:
 *   getMemberStatement(session, input)          — app code.
 *   getMemberStatementWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import { membership, invoice, appUser } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { findBillingAccountTx } from './ledger-internal.js';
import { toInvoiceView } from './list-invoices.js';
import type { InvoiceView } from './list-invoices.js';
import { extractRows } from '../db-rows.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const getMemberStatementInputSchema = z.object({
  memberId: z.string().regex(UUID_RE, { message: 'memberId must be a UUID' }),
});

export type GetMemberStatementInput = { memberId: string };

// ─── Output types ─────────────────────────────────────────────────────────────

export interface MemberStatementLedgerRow {
  id: string;
  entryType: 'invoice_finalized' | 'payment' | 'credit_memo' | 'adjustment' | 'block_purchase';
  direction: 'debit' | 'credit';
  amountCents: number;
  invoiceId: string | null;
  paymentId: string | null;
  memo: string | null;
  createdAt: Date;
  /** Derived balance immediately AFTER this entry — see module METRIC DEFINITION. */
  runningBalanceCents: number;
}

export interface MemberStatement {
  memberUserId: string;
  memberName: string;
  /** Newest-first, same shape as list-invoices.ts. */
  invoices: InvoiceView[];
  /** Oldest-first (chronological), each row carrying its running balance. */
  ledger: MemberStatementLedgerRow[];
  /** The member's current derived balance — equals the last ledger row's runningBalanceCents, or 0 if no ledger activity. */
  endingBalanceCents: number;
}

export type GetMemberStatementResult =
  | { ok: true; statement: MemberStatement }
  | { ok: false; reason: 'not_found' };

// ─── Row shapes from raw queries ───────────────────────────────────────────────

interface RawLedgerRow {
  id: string;
  entryType: string;
  direction: string;
  amountCents: number;
  invoiceId: string | null;
  paymentId: string | null;
  memo: string | null;
  createdAt: Date | string;
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetMemberStatementInput,
): Promise<GetMemberStatementResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:access');

  // 2. Validate input.
  const parsed = getMemberStatementInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid getMemberStatement input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { memberId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // memberId must be a member of THIS org — RLS also backstops this
    // (membership rows are org-scoped); an explicit check gives a clean
    // not_found instead of a silently-empty statement.
    const memberRows = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(and(eq(membership.userId, memberId), eq(membership.orgId, sess.orgId)))
      .limit(1);
    if (!memberRows[0]) {
      return { ok: false, reason: 'not_found' } as const;
    }

    // Member display name (fullName ?? email — mirrors people/list-members.ts).
    const nameRows = await tx
      .select({ fullName: appUser.fullName, email: appUser.email })
      .from(appUser)
      .where(eq(appUser.id, memberId))
      .limit(1);
    const nameRow = nameRows[0];
    const memberName = nameRow?.fullName ?? nameRow?.email ?? memberId;

    // Invoices — newest first, same view builder as list-invoices.ts.
    const invoiceRows = await tx
      .select()
      .from(invoice)
      .where(eq(invoice.memberUserId, memberId))
      .orderBy(desc(invoice.createdAt));
    const invoices = invoiceRows.map(toInvoiceView);

    // Ledger — chronological (oldest first) with a running balance.
    const accountId = await findBillingAccountTx(tx, sess.orgId, memberId);
    let ledger: MemberStatementLedgerRow[] = [];
    if (accountId) {
      const ledgerResult = await tx.execute(sql`
        SELECT
          id                AS "id",
          entry_type        AS "entryType",
          direction         AS "direction",
          amount_cents      AS "amountCents",
          invoice_id        AS "invoiceId",
          payment_id        AS "paymentId",
          memo              AS "memo",
          created_at        AS "createdAt"
        FROM ledger_entry
        WHERE account_id = ${accountId}::uuid
        ORDER BY created_at ASC, id ASC
      `);
      const rawRows = extractRows<RawLedgerRow>(ledgerResult);

      let running = 0;
      ledger = rawRows.map((r) => {
        const amountCents = Number(r.amountCents);
        running += r.direction === 'credit' ? amountCents : -amountCents;
        return {
          id: r.id,
          entryType: r.entryType as MemberStatementLedgerRow['entryType'],
          direction: r.direction as MemberStatementLedgerRow['direction'],
          amountCents,
          invoiceId: r.invoiceId,
          paymentId: r.paymentId,
          memo: r.memo,
          createdAt: toDate(r.createdAt),
          runningBalanceCents: running,
        };
      });
    }

    const endingBalanceCents = ledger.length > 0 ? ledger[ledger.length - 1]!.runningBalanceCents : 0;

    return {
      ok: true,
      statement: {
        memberUserId: memberId,
        memberName,
        invoices,
        ledger,
        endingBalanceCents,
      },
    } as const;
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getMemberStatement(
  session: AppSession | null | undefined,
  input: GetMemberStatementInput,
): Promise<GetMemberStatementResult> {
  const db = await getDb();
  return _impl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getMemberStatementWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetMemberStatementInput,
): Promise<GetMemberStatementResult> {
  return _impl(db, session, input);
}
