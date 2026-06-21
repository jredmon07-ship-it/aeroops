/**
 * invoice-status-commands.ts — Invoice status transitions: finalize + void.
 * (Slice B1 — status only, NO money, NO Stripe, NO charge)
 *
 * TRANSITIONS:
 *   draft      → finalized  (sets issued_at; immutable after)
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
 *   - One audit row per successful transition.
 *   - NO money, NO Stripe, NO payment.
 *
 * TWO CALLING FORMS per command:
 *   fn(session, input)          — app code.
 *   fnWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { eq, and, sql, or } from 'drizzle-orm';
import { invoice, auditLog } from '@aeroops/db';
import type { AnyDb, InvoiceSelect } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toInvoiceView } from './list-invoices.js';
import type { InvoiceView } from './list-invoices.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invoiceIdSchema = z.object({
  id: z.string().regex(UUID_RE, { message: 'id must be a UUID' }),
});

// ─── finalizeInvoice ─────────────────────────────────────────────────────────

export type FinalizeInvoiceResult =
  | { ok: true;  invoice: InvoiceView }
  | { ok: false; reason: 'not_found' | 'not_draft' };

async function _finalizeInvoiceImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
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

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
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

    return { ok: true, invoice: toInvoiceView(updated[0]) };
  });
}

export async function finalizeInvoice(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<FinalizeInvoiceResult> {
  const db = await getDb();
  return _finalizeInvoiceImpl(db, session, input);
}

export async function finalizeInvoiceWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<FinalizeInvoiceResult> {
  return _finalizeInvoiceImpl(db, session, input);
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
