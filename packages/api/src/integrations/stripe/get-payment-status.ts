/**
 * integrations/stripe/get-payment-status.ts — getPaymentStatus (Slice B3-foundation).
 *
 * READ-ONLY. Reads OUR OWN payment_intent_record row(s) for an invoice — it
 * does NOT call the Stripe API. This is intentional: "webhooks are the
 * source of truth" (ADR-0015) — a client-triggered "refresh from Stripe"
 * button is explicitly OUT of scope here to keep the single source of truth
 * for `status` as the webhook-driven UPDATE
 * (integrations/stripe/handle-webhook-event.ts). A future slice may add an
 * explicit manual-refresh command that calls client.retrievePaymentIntent()
 * — this command does not.
 *
 * GUARANTEES:
 *   - authz FIRST: billing:access before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Returns the MOST RECENT payment_intent_record for the invoice (an
 *     invoice can accumulate multiple PaymentIntents across retries — the
 *     latest one is the one that matters for "can this invoice still be paid").
 *   - NO Stripe call, NO card/bank data.
 *
 * TWO CALLING FORMS:
 *   getPaymentStatus(session, input)          — app code.
 *   getPaymentStatusWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { invoice, paymentIntentRecord } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../../auth/session.js';
import { getDb } from '../../db.js';
import type { AppSession } from '../../auth/types.js';
import { ValidationError } from '../../scheduling/internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const getPaymentStatusInputSchema = z.object({
  invoiceId: z.string().regex(UUID_RE, { message: 'invoiceId must be a UUID' }),
});

export type GetPaymentStatusInput = z.infer<typeof getPaymentStatusInputSchema>;

export interface PaymentIntentRecordView {
  id: string;
  stripePaymentIntentId: string;
  amountCents: number;
  paymentMethodTypes: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  createdAt: Date;
  updatedAt: Date;
}

export type GetPaymentStatusResult =
  | { ok: true; record: PaymentIntentRecordView | null }
  | { ok: false; reason: 'not_found' };

async function _getPaymentStatusImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GetPaymentStatusResult> {
  requireCapability(session, 'billing:access');

  const parsed = getPaymentStatusInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[stripe] invalid getPaymentStatus input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { invoiceId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const invoiceRows = await tx.select({ id: invoice.id }).from(invoice).where(eq(invoice.id, invoiceId)).limit(1);
    if (!invoiceRows[0]) {
      return { ok: false, reason: 'not_found' } as const;
    }

    const rows = await tx
      .select()
      .from(paymentIntentRecord)
      .where(eq(paymentIntentRecord.invoiceId, invoiceId))
      .orderBy(desc(paymentIntentRecord.createdAt))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return { ok: true, record: null } as const;
    }

    return {
      ok: true,
      record: {
        id: row.id,
        stripePaymentIntentId: row.stripePaymentIntentId,
        amountCents: row.amountCents,
        paymentMethodTypes: row.paymentMethodTypes,
        status: row.status as PaymentIntentRecordView['status'],
        createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as string),
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt as string),
      },
    } as const;
  });
}

export async function getPaymentStatus(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetPaymentStatusResult> {
  const db = await getDb();
  return _getPaymentStatusImpl(db, session, input);
}

export async function getPaymentStatusWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetPaymentStatusResult> {
  return _getPaymentStatusImpl(db, session, input);
}
