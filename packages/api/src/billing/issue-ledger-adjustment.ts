/**
 * billing/issue-ledger-adjustment.ts — issueCreditMemo / issueAdjustment
 * (FC-parity Slice 2 — credit memo / adjustment UI).
 *
 * Billing corrections currently have NO command path: `ledger_entry` has
 * carried the 'credit_memo' and 'adjustment' entry_type values since
 * migration 0022 (widened again in 0034), but nothing could ever post one.
 * This closes that gap with two thin, audited commands that mirror
 * recordManualPayment exactly (record-manual-payment.ts) — same shape, same
 * guarantees, same APPEND-ONLY posture.
 *
 * issueCreditMemo — posts ONE 'credit_memo' CREDIT (raises the member's
 *   balance). Use for a billing correction / refund acknowledgement in the
 *   member's favor (e.g. "we overcharged, here is a credit").
 * issueAdjustment — posts ONE 'adjustment' entry in EITHER direction
 *   ('debit' lowers the balance, 'credit' raises it). REQUIRES a nonempty
 *   memo (min 5 chars) — an unexplained balance adjustment is a
 *   records-integrity smell, so the reason is mandatory, not optional.
 *
 * GUARANTEES (identical to recordManualPayment):
 *   - authz FIRST: billing:manage before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - memberUserId must be a member of this org (membership check).
 *   - amountCents must be a positive integer (Zod + DB CHECK) — the sign of
 *     the movement is carried by `direction`, never a negative amount.
 *   - APPEND-ONLY: ledger_entry has no UPDATE/DELETE RLS policy — a mistaken
 *     credit memo or adjustment is corrected with a NEW reversing entry,
 *     never edited.
 *   - ONE audit row each: 'billing.credit_memo_issued' /
 *     'billing.adjustment_issued'.
 *   - NO Stripe, NO card/bank data — `memo` is a free-text operator note.
 *
 * TWO CALLING FORMS per command:
 *   fn(session, input)          — app code.
 *   fnWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { membership, ledgerEntry, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { computeBalance } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { ensureBillingAccountTx, loadLedgerEntryAmountsTx } from './ledger-internal.js';
import type { LedgerEntryView } from './ledger-account.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Input schemas ────────────────────────────────────────────────────────────

const issueCreditMemoInputSchema = z.object({
  memberUserId: z.string().regex(UUID_RE, { message: 'memberUserId must be a UUID' }),
  amountCents: z
    .number()
    .int({ message: 'amountCents must be an integer' })
    .positive({ message: 'amountCents must be > 0' })
    // ledger_entry.amount_cents is int4 — reject anything that would overflow
    // the column (2,147,483,647 = $21.47M) rather than let Postgres throw.
    .max(2_147_483_647, { message: 'amountCents exceeds the maximum ($21,474,836.47)' }),
  memo: z.string().trim().min(1).max(1000).optional(),
});

export type IssueCreditMemoInput = z.infer<typeof issueCreditMemoInputSchema>;

const issueAdjustmentInputSchema = z.object({
  memberUserId: z.string().regex(UUID_RE, { message: 'memberUserId must be a UUID' }),
  amountCents: z
    .number()
    .int({ message: 'amountCents must be an integer' })
    .positive({ message: 'amountCents must be > 0' })
    // ledger_entry.amount_cents is int4 — reject overflow (see issueCreditMemo).
    .max(2_147_483_647, { message: 'amountCents exceeds the maximum ($21,474,836.47)' }),
  direction: z.enum(['debit', 'credit']),
  // An unexplained balance adjustment is a records-integrity smell — the
  // reason is REQUIRED (unlike recordManualPayment's optional memo).
  memo: z
    .string()
    .trim()
    .min(5, { message: 'memo must explain the adjustment (at least 5 characters)' })
    .max(1000),
});

export type IssueAdjustmentInput = z.infer<typeof issueAdjustmentInputSchema>;

// ─── Result types ─────────────────────────────────────────────────────────────

export type IssueCreditMemoResult =
  | { ok: true; entry: LedgerEntryView; balanceCentsAfter: number }
  | { ok: false; reason: 'member_not_found' };

export type IssueAdjustmentResult =
  | { ok: true; entry: LedgerEntryView; balanceCentsAfter: number }
  | { ok: false; reason: 'member_not_found' };

// ─── Shared core — posts ONE ledger_entry + ONE audit row ────────────────────
// Both commands are the same shape as recordManualPayment: authz → validate →
// membership check → ensure account → INSERT → audit → fresh derived balance.
// Factored once here rather than copy-pasted twice.

async function _postLedgerEntryImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  opts: {
    schema: z.ZodTypeAny;
    entryType: 'credit_memo' | 'adjustment';
    defaultDirection: 'debit' | 'credit';
    auditAction: 'billing.credit_memo_issued' | 'billing.adjustment_issued';
    validationLabel: string;
  },
): Promise<
  | { ok: true; entry: LedgerEntryView; balanceCentsAfter: number }
  | { ok: false; reason: 'member_not_found' }
> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:manage');

  // 2. VALIDATE input.
  const parsed = opts.schema.safeParse(rawInput);
  if (!parsed.success) {
    const first = (parsed.error as z.ZodError).issues[0];
    throw new ValidationError(
      `[billing] invalid ${opts.validationLabel} input: ${first?.message ?? 'unknown'}`,
    );
  }
  const data = parsed.data as {
    memberUserId: string;
    amountCents: number;
    memo?: string;
    direction?: 'debit' | 'credit';
  };
  const { memberUserId, amountCents, memo } = data;
  const direction = data.direction ?? opts.defaultDirection;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. memberUserId must be a member of this org.
    const memberRows = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(and(eq(membership.userId, memberUserId), eq(membership.orgId, sess.orgId)))
      .limit(1);
    if (!memberRows[0]) {
      return { ok: false, reason: 'member_not_found' } as const;
    }

    // 4. Lazily ensure the billing_account row.
    const accountId = await ensureBillingAccountTx(tx, sess.orgId, memberUserId);

    // 5. INSERT the entry.
    const inserted = await tx
      .insert(ledgerEntry)
      .values({
        orgId: sess.orgId,
        accountId,
        entryType: opts.entryType,
        direction,
        amountCents,
        invoiceId: null,
        paymentId: null,
        memo: memo ?? null,
        createdBy: sess.userId,
      })
      .returning();

    const row = inserted[0];
    if (!row) {
      throw new Error(
        `[billing] ${opts.validationLabel}: ledger_entry INSERT returned no rows`,
      );
    }

    // 6. ONE audit row.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: opts.auditAction,
      entityType: 'ledger_entry',
      entityId: row.id,
      metadata: {
        memberUserId,
        amountCents,
        direction,
        memo: memo ?? null,
      },
    });

    // 7. Fresh derived balance for the caller's convenience.
    const entries = await loadLedgerEntryAmountsTx(tx, accountId);
    const balanceCentsAfter = computeBalance(entries);

    return {
      ok: true,
      entry: {
        id: row.id,
        entryType: row.entryType as LedgerEntryView['entryType'],
        direction: row.direction as LedgerEntryView['direction'],
        amountCents: row.amountCents,
        invoiceId: row.invoiceId,
        paymentId: row.paymentId,
        memo: row.memo,
        createdBy: row.createdBy,
        createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as string),
      },
      balanceCentsAfter,
    } as const;
  });
}

// ─── issueCreditMemo ──────────────────────────────────────────────────────────

async function _issueCreditMemoImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<IssueCreditMemoResult> {
  return _postLedgerEntryImpl(db, session, rawInput, {
    schema: issueCreditMemoInputSchema,
    entryType: 'credit_memo',
    defaultDirection: 'credit',
    auditAction: 'billing.credit_memo_issued',
    validationLabel: 'issueCreditMemo',
  });
}

export async function issueCreditMemo(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<IssueCreditMemoResult> {
  const db = await getDb();
  return _issueCreditMemoImpl(db, session, input);
}

export async function issueCreditMemoWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<IssueCreditMemoResult> {
  return _issueCreditMemoImpl(db, session, input);
}

// ─── issueAdjustment ──────────────────────────────────────────────────────────

async function _issueAdjustmentImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<IssueAdjustmentResult> {
  return _postLedgerEntryImpl(db, session, rawInput, {
    schema: issueAdjustmentInputSchema,
    entryType: 'adjustment',
    // defaultDirection is unused for adjustment — direction is always
    // explicit in the validated input — but required by the shared shape.
    defaultDirection: 'debit',
    auditAction: 'billing.adjustment_issued',
    validationLabel: 'issueAdjustment',
  });
}

export async function issueAdjustment(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<IssueAdjustmentResult> {
  const db = await getDb();
  return _issueAdjustmentImpl(db, session, input);
}

export async function issueAdjustmentWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<IssueAdjustmentResult> {
  return _issueAdjustmentImpl(db, session, input);
}
