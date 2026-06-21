/**
 * generate-invoice.ts — Generate a DRAFT invoice from a closed dispatch ticket.
 * (Slice B1 — DRAFT only, NO charge, NO Stripe, NO payment)
 *
 * BILLING BOUNDARY: this command ONLY creates a DRAFT invoice record. Nothing
 * is charged or transmitted to any payment processor. The dispatch gate and
 * close path are NEVER touched — this command reads the stored meters and
 * flight_time_hours via getEffectiveMeter (which itself is READ-ONLY).
 *
 * FLOW:
 *   1. requireCapability('billing:manage') FIRST.
 *   2. Load effective meters via getEffectiveMeter (latest correction ?? original).
 *   3. Load the rate schedule (must be in this org, RLS-scoped).
 *   4. Compute line via applyRate / computeLineTotal + totals via computeInvoiceTotals.
 *   5. INSERT draft invoice + one line item in ONE tx.
 *   6. ONE audit row: 'billing.invoice_drafted'.
 *   7. Return the draft invoice with line items.
 *
 * GUARANTEES:
 *   - authz FIRST: billing:manage before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Ticket must be CLOSED (billing reads the stored flight_time_hours only).
 *   - Rate must exist in this org (RLS will reject if not).
 *   - Money = INTEGER CENTS only (via @aeroops/core applyRate / computeInvoiceTotals).
 *   - NO Stripe, NO payment, NO finalization here.
 *   - Finalized invoices are immutable (rejected by finalizeInvoice/voidInvoice).
 *   - member_user_id: required input (the pilot from the ticket or an override).
 *     In B1, the caller must supply it; future slices may auto-populate from the ticket.
 *
 * TWO CALLING FORMS:
 *   generateInvoiceFromDispatch(session, input)          — app code.
 *   generateInvoiceFromDispatchWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { invoice, invoiceLineItem, rateSchedule, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { applyRate, computeInvoiceTotals } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { getEffectiveMeter } from './effective-meter.js';
import type { InvoiceView, InvoiceLineItemView } from './list-invoices.js';
import { toInvoiceView, toLineItemView } from './list-invoices.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Input schema ─────────────────────────────────────────────────────────────

const generateInvoiceInputSchema = z.object({
  dispatchTicketId: z.string().regex(UUID_RE, { message: 'dispatchTicketId must be a UUID' }),
  rateScheduleId:   z.string().regex(UUID_RE, { message: 'rateScheduleId must be a UUID' }),
  memberUserId:     z.string().regex(UUID_RE, { message: 'memberUserId must be a UUID' }),
});

export type GenerateInvoiceFromDispatchInput = z.infer<typeof generateInvoiceInputSchema>;

// ─── Result types ─────────────────────────────────────────────────────────────

export type GenerateInvoiceFromDispatchResult =
  | {
      ok: true;
      invoice: InvoiceView & { lineItems: InvoiceLineItemView[] };
    }
  | {
      ok: false;
      reason: 'ticket_not_found' | 'ticket_not_closed' | 'rate_not_found';
    };

// ─── Shared implementation ────────────────────────────────────────────────────

async function _generateInvoiceFromDispatchImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GenerateInvoiceFromDispatchResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:manage');

  // 2. VALIDATE input.
  const parsed = generateInvoiceInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid generateInvoiceFromDispatch input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { dispatchTicketId, rateScheduleId, memberUserId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Get effective meters (reads latest correction ?? original).
    const meterResult = await getEffectiveMeter(tx, dispatchTicketId);

    if (!meterResult.ok) {
      if (meterResult.reason === 'not_found') {
        return { ok: false, reason: 'ticket_not_found' } as const;
      }
      return { ok: false, reason: 'ticket_not_closed' } as const;
    }

    // 4. Load the rate schedule (RLS scopes to org).
    const rateRows = await tx
      .select()
      .from(rateSchedule)
      .where(eq(rateSchedule.id, rateScheduleId))
      .limit(1);

    const rate = rateRows[0];
    if (!rate) {
      return { ok: false, reason: 'rate_not_found' } as const;
    }

    // 5. Compute line total — pure integer cents math.
    // quantity = stored flightTimeHours (NOT recomputed from effective meters).
    const quantityHours  = meterResult.flightTimeHours;
    const unitAmountCents = rate.amountCents;
    const lineTotalCents  = applyRate(quantityHours, unitAmountCents);

    // 6. Compute invoice totals.
    const totals = computeInvoiceTotals([{ lineTotalCents }]);

    // 7. INSERT draft invoice + one line item in ONE tx.
    const invoiceInserted = await tx
      .insert(invoice)
      .values({
        orgId:           sess.orgId,
        memberUserId,
        status:          'draft',
        subtotalCents:   totals.subtotalCents,
        totalCents:      totals.totalCents,
        dispatchTicketId,
        issuedAt:        null,
        createdBy:       sess.userId,
      })
      .returning();

    const invoiceRow = invoiceInserted[0];
    if (!invoiceRow) throw new Error('[billing] generateInvoiceFromDispatch: invoice INSERT returned no rows');

    const lineItemDescription =
      `${rate.rateKind.replace(/_/g, ' ')} – ${quantityHours.toFixed(1)} hrs @ ${(unitAmountCents / 100).toFixed(2)}`;

    const lineInserted = await tx
      .insert(invoiceLineItem)
      .values({
        orgId:          sess.orgId,
        invoiceId:      invoiceRow.id,
        description:    lineItemDescription,
        quantityHours:  quantityHours.toFixed(1),
        unitAmountCents,
        lineTotalCents,
        rateScheduleId,
      })
      .returning();

    const lineRow = lineInserted[0];
    if (!lineRow) throw new Error('[billing] generateInvoiceFromDispatch: line item INSERT returned no rows');

    // 8. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'billing.invoice_drafted',
      entityType:  'invoice',
      entityId:    invoiceRow.id,
      metadata: {
        invoiceId:       invoiceRow.id,
        dispatchTicketId,
        rateScheduleId,
        memberUserId,
        quantityHours,
        unitAmountCents,
        lineTotalCents,
        subtotalCents:   totals.subtotalCents,
        totalCents:      totals.totalCents,
        correctionApplied: meterResult.correctionApplied,
      },
    });

    return {
      ok: true,
      invoice: {
        ...toInvoiceView(invoiceRow),
        lineItems: [toLineItemView(lineRow)],
      },
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function generateInvoiceFromDispatch(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GenerateInvoiceFromDispatchResult> {
  const db = await getDb();
  return _generateInvoiceFromDispatchImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function generateInvoiceFromDispatchWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GenerateInvoiceFromDispatchResult> {
  return _generateInvoiceFromDispatchImpl(db, session, input);
}
