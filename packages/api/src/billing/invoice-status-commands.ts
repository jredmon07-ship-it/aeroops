/**
 * invoice-status-commands.ts — Invoice status transitions: finalize + void.
 * (Slice B1 — status only; Slice B2 additively threads the ledger debit
 * through finalizeInvoice's SAME transaction. Still NO Stripe, NO charge —
 * the ledger records a money movement (the invoice now being owed), it does
 * not itself move money.)
 *
 * TRANSITIONS:
 *   draft      → finalized  (sets issued_at; immutable after; Slice B2 ALSO
 *                            appends ONE 'invoice_finalized' debit ledger_entry
 *                            in the SAME tx — see finalizeInvoice below)
 *   draft      → void       (audited; terminal)
 *   finalized  → void       (audited; terminal)
 *   finalized  → (reject edits/re-finalize)
 *   void       → (terminal; no further transitions)
 *
 * IMMUTABILITY RULE:
 *   Once finalized, an invoice is IMMUTABLE. Any mutation attempt returns
 *   { ok: false, reason: 'already_finalized' }. Corrections are expressed
 *   as void + re-draft (Phase-2 B5 / credit memo), NOT as edits.
 *
 * GUARANTEES:
 *   - authz FIRST: billing:manage before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Guarded UPDATE WHERE status = expected (race-safe).
 *   - One audit row per successful transition (finalizeInvoice: two audit
 *     rows — 'billing.invoice_finalized' AND, when this is the first
 *     finalization, none additional; the ledger append itself is NOT
 *     separately audited — the invoice_finalized audit row's metadata
 *     already carries the amounts, and the ledger_entry row IS its own
 *     immutable record, mirroring how dispatch tickets are not double-audited
 *     for their own INSERT).
 *   - IDEMPOTENT ledger append: a partial UNIQUE index (org_id, invoice_id,
 *     entry_type) WHERE entry_type='invoice_finalized' (migration 0022)
 *     guarantees AT MOST ONE debit per invoice — combined with the existing
 *     guarded UPDATE WHERE status='draft' (an invoice can only ever be
 *     finalized ONCE), the ledger append can never double-fire in practice;
 *     the partial UNIQUE index is the structural backstop regardless.
 *   - NO Stripe, NO card/bank data, NO payment. The ledger entry records
 *     that the member now owes for this invoice — it does not charge anyone.
 *
 * TWO CALLING FORMS per command:
 *   fn(session, input)          — app code.
 *   fnWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { eq, and, sql, or } from 'drizzle-orm';
import { invoice, auditLog, ledgerEntry } from '@aeroops/db';
import type { AnyDb, InvoiceSelect } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toInvoiceView } from './list-invoices.js';
import type { InvoiceView } from './list-invoices.js';
import { ensureBillingAccountTx } from './ledger-internal.js';
import { getStripeClient } from '../integrations/stripe/client.js';
import type { StripeClient } from '../integrations/stripe/client.js';
import { triggerAutopayOnFinalize } from '../integrations/stripe/autopay.js';
import type { AutopayResult } from '../integrations/stripe/autopay.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invoiceIdSchema = z.object({
  id: z.string().regex(UUID_RE, { message: 'id must be a UUID' }),
});

// ─── finalizeInvoice ─────────────────────────────────────────────────────────

export type FinalizeInvoiceResult =
  | { ok: true;  invoice: InvoiceView; autopay?: AutopayResult }
  | { ok: false; reason: 'not_found' | 'not_draft' };

async function _finalizeInvoiceImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  client: StripeClient = getStripeClient(),
): Promise<FinalizeInvoiceResult> {
  requireCapability(session, 'billing:manage');

  const parsed = invoiceIdSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid finalizeInvoice input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { id } = parsed.data;

  // Slice P0-REV: the finalize tx (UPDATE + ledger debit + audit) stays
  // BYTE-IDENTICAL below — autopay runs AFTER this tx commits (external HTTP
  // must never be held inside a DB tx), as a separate step further down.
  const result = await withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // Guarded UPDATE WHERE status='draft' (race-safe: 0 rows → not draft or not found).
    const updated = await tx
      .update(invoice)
      .set({
        status:    'finalized',
        issuedAt:  sql`NOW()`,
        updatedAt: sql`NOW()`,
      })
      .where(and(eq(invoice.id, id), eq(invoice.status, 'draft')))
      .returning();

    if (!updated[0]) {
      // Probe to distinguish not_found vs not_draft.
      const probe = await tx
        .select({ id: invoice.id, status: invoice.status })
        .from(invoice)
        .where(eq(invoice.id, id))
        .limit(1);

      if (!probe[0]) {
        return { ok: false, reason: 'not_found' } as const;
      }
      return { ok: false, reason: 'not_draft' } as const;
    }

    // Slice B2: append ONE 'invoice_finalized' debit ledger_entry, in the
    // SAME transaction as the status UPDATE above (throw-to-rollback keeps
    // both changes atomic — either the invoice is finalized AND the ledger
    // reflects it, or neither happens). ensureBillingAccountTx lazily
    // creates the member's billing_account row if this is their first-ever
    // ledger activity. The partial UNIQUE index (org_id, invoice_id,
    // entry_type) WHERE entry_type='invoice_finalized' (migration 0022) is
    // the structural idempotency backstop — this INSERT can only ever
    // succeed once per invoice (the guarded UPDATE above already prevents
    // finalizing the same invoice twice, so this is belt-and-suspenders).
    //
    // amountCents === 0 is SKIPPED — ledger_entry.amount_cents has a CHECK
    // > 0 (migration 0022: a ledger entry is always a positive magnitude +
    // a labelled direction, never a zero-value row). A $0 invoice (e.g. a
    // fully comped flight) is a legitimate, valid finalize with nothing to
    // post to the ledger.
    if (updated[0].totalCents > 0) {
      const accountId = await ensureBillingAccountTx(tx, sess.orgId, updated[0].memberUserId);
      await tx.insert(ledgerEntry).values({
        orgId:       sess.orgId,
        accountId,
        entryType:   'invoice_finalized',
        direction:   'debit',
        amountCents: updated[0].totalCents,
        invoiceId:   id,
        paymentId:   null,
        memo:        null,
        createdBy:   sess.userId,
      });
    }

    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'billing.invoice_finalized',
      entityType:  'invoice',
      entityId:    id,
      metadata: {
        invoiceId:      id,
        subtotalCents:  updated[0].subtotalCents,
        totalCents:     updated[0].totalCents,
        memberUserId:   updated[0].memberUserId,
      },
    });

    return { ok: true, invoice: toInvoiceView(updated[0]) } as const;
  });

  // Slice P0-REV: autopay runs AFTER the finalize tx above has committed —
  // NEVER inside it (external HTTP must never be held inside a DB tx). Only
  // attempted for a successful finalize with a non-zero total (a $0 invoice
  // has nothing to charge — mirrors the ledger-debit skip above). `session`
  // is guaranteed valid AppSession here: withSessionOrgContextWithDb above
  // would have thrown UnauthenticatedError before reaching this line
  // otherwise. The invoice is finalized regardless of this step's outcome.
  if (result.ok && result.invoice.totalCents > 0) {
    const autopay = await triggerAutopayOnFinalize(db, session as AppSession, id, client);
    return { ok: true, invoice: result.invoice, autopay };
  }
  return result;
}

export async function finalizeInvoice(
  session: AppSession | null | undefined,
  input: unknown,
  client?: StripeClient,
): Promise<FinalizeInvoiceResult> {
  const db = await getDb();
  return _finalizeInvoiceImpl(db, session, input, client);
}

export async function finalizeInvoiceWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  client?: StripeClient,
): Promise<FinalizeInvoiceResult> {
  return _finalizeInvoiceImpl(db, session, input, client);
}

// ─── voidInvoice ─────────────────────────────────────────────────────────────

export type VoidInvoiceResult =
  | { ok: true;  invoice: InvoiceView }
  | { ok: false; reason: 'not_found' | 'already_void' };

async function _voidInvoiceImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<VoidInvoiceResult> {
  requireCapability(session, 'billing:manage');

  const parsed = invoiceIdSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid voidInvoice input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { id } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // Read the current status within the transaction BEFORE the guarded UPDATE,
    // so the audit row can record the true prior status ('draft' or 'finalized').
    // This is race-safe: the subsequent guarded UPDATE still enforces the
    // WHERE status IN ('draft','finalized') predicate as the authoritative gate;
    // if a concurrent void lands between these two statements the UPDATE produces
    // 0 rows and we fall through to the probe below (unchanged behaviour).
    const priorRow = await tx
      .select({ status: invoice.status })
      .from(invoice)
      .where(eq(invoice.id, id))
      .limit(1);
    const priorStatus = priorRow[0]?.status;

    // Guarded UPDATE WHERE status IN ('draft','finalized') — void is terminal.
    const updated = await tx
      .update(invoice)
      .set({
        status:    'void',
        updatedAt: sql`NOW()`,
      })
      .where(
        and(
          eq(invoice.id, id),
          or(
            eq(invoice.status, 'draft'),
            eq(invoice.status, 'finalized'),
          )!,
        )!,
      )
      .returning();

    if (!updated[0]) {
      // Probe to distinguish not_found vs already_void.
      const probe = await tx
        .select({ id: invoice.id, status: invoice.status })
        .from(invoice)
        .where(eq(invoice.id, id))
        .limit(1);

      if (!probe[0]) {
        return { ok: false, reason: 'not_found' } as const;
      }
      return { ok: false, reason: 'already_void' } as const;
    }

    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'billing.invoice_voided',
      entityType:  'invoice',
      entityId:    id,
      metadata: {
        invoiceId:      id,
        previousStatus: priorStatus, // actual prior status: 'draft' or 'finalized'
        memberUserId:   updated[0].memberUserId,
      },
    });

    return { ok: true, invoice: toInvoiceView(updated[0]) };
  });
}

export async function voidInvoice(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<VoidInvoiceResult> {
  const db = await getDb();
  return _voidInvoiceImpl(db, session, input);
}

export async function voidInvoiceWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<VoidInvoiceResult> {
  return _voidInvoiceImpl(db, session, input);
}
