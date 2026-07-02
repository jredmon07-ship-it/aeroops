/**
 * billing/record-manual-payment.ts — recordManualPayment (Slice B2).
 *
 * An operator records a check/cash/external payment for a member. Posts ONE
 * 'payment' credit ledger_entry — this is what makes the balance gate
 * meaningful with ZERO Stripe (a fully-manual operator can still track
 * account balances). Slice B3's Stripe webhook posts the same entry_type
 * automatically on a verified `payment_intent.succeeded` event, with
 * paymentId = the Stripe PaymentIntent id instead of an operator note.
 *
 * FLOW:
 *   1. requireCapability('billing:manage') FIRST.
 *   2. memberUserId must be a member of this org (membership check).
 *   3. ensureBillingAccountTx — lazily creates the account if this is the
 *      member's first-ever ledger activity.
 *   4. INSERT ONE ledger_entry (entry_type='payment', direction='credit',
 *      amount_cents=input.amountCents, payment_id=input.methodNote ?? null,
 *      memo=input.memo ?? null) + ONE audit row, in the SAME tx.
 *
 * GUARANTEES:
 *   - authz FIRST: billing:manage before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - amountCents must be a positive integer (Zod + DB CHECK).
 *   - APPEND-ONLY: ledger_entry has no UPDATE/DELETE RLS policy — a mistaken
 *     manual payment is corrected with a NEW reversing/adjustment entry
 *     (forward seam), never edited.
 *   - ONE audit row: 'billing.manual_payment_recorded'.
 *   - NO Stripe, NO card/bank data — `methodNote` is a free-text operator
 *     reference (e.g. "Check #1042", "Cash at front desk"), NEVER a raw
 *     payment instrument.
 *
 * TWO CALLING FORMS:
 *   recordManualPayment(session, input)          — app code.
 *   recordManualPaymentWithDb(db, session, input) — tests.
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

// ─── Input schema ─────────────────────────────────────────────────────────────

const recordManualPaymentInputSchema = z.object({
  memberUserId: z.string().regex(UUID_RE, { message: 'memberUserId must be a UUID' }),
  amountCents: z
    .number()
    .int({ message: 'amountCents must be an integer' })
    .positive({ message: 'amountCents must be > 0' }),
  methodNote: z.string().trim().min(1).max(200).optional(),
  memo: z.string().trim().min(1).max(1000).optional(),
});

export type RecordManualPaymentInput = z.infer<typeof recordManualPaymentInputSchema>;

// ─── Result type ──────────────────────────────────────────────────────────────

export type RecordManualPaymentResult =
  | { ok: true; entry: LedgerEntryView; balanceCentsAfter: number }
  | { ok: false; reason: 'member_not_found' };

// ─── Shared implementation ────────────────────────────────────────────────────

async function _recordManualPaymentImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<RecordManualPaymentResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:manage');

  // 2. VALIDATE input.
  const parsed = recordManualPaymentInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid recordManualPayment input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { memberUserId, amountCents, methodNote, memo } = parsed.data;

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

    // 5. INSERT the 'payment' credit entry.
    const inserted = await tx
      .insert(ledgerEntry)
      .values({
        orgId: sess.orgId,
        accountId,
        entryType: 'payment',
        direction: 'credit',
        amountCents,
        invoiceId: null,
        paymentId: methodNote ?? null,
        memo: memo ?? null,
        createdBy: sess.userId,
      })
      .returning();

    const row = inserted[0];
    if (!row) throw new Error('[billing] recordManualPayment: ledger_entry INSERT returned no rows');

    // 6. ONE audit row.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.manual_payment_recorded',
      entityType: 'ledger_entry',
      entityId: row.id,
      metadata: {
        memberUserId,
        amountCents,
        methodNote: methodNote ?? null,
      },
    });

    // 7. Fresh derived balance for the caller's convenience (a re-fetch, not
    //    a stored/cached value).
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

// ─── App-code form ────────────────────────────────────────────────────────────

export async function recordManualPayment(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<RecordManualPaymentResult> {
  const db = await getDb();
  return _recordManualPaymentImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function recordManualPaymentWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<RecordManualPaymentResult> {
  return _recordManualPaymentImpl(db, session, input);
}
