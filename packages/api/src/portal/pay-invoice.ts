/**
 * portal/pay-invoice.ts — payMyInvoice (Slice P0-REV, C4).
 *
 * SELF-SCOPED (portal:access): pay one of the caller's OWN finalized
 * invoices. subject = session.userId ONLY. Loads the invoice and requires
 * BOTH status='finalized' AND memberUserId === session.userId — either
 * mismatch returns 'not_found' (never leaks another member's invoice
 * existence, mirroring the P1 portal's zero-IDOR posture).
 *
 * Reuses the EXACT PI-creation + idempotency core
 * (createPaymentIntentForInvoiceTx) that createInvoicePaymentIntent (staff)
 * uses — behavior/idempotency is identical, only the audit action name
 * differs ('billing.self_pay_payment_intent_created').
 *
 * NEVER posts a ledger credit — only a verified `payment_intent.succeeded`
 * webhook ever does that (webhooks are the sole settlement path).
 *
 * GUARANTEES:
 *   - authz FIRST: portal:access before any data access.
 *   - org_id + subject from session only (withSessionOrgContextWithDb).
 *   - not_configured typed refusal on a StubStripeClient — never a crash.
 *
 * TWO CALLING FORMS:
 *   payMyInvoice(session, input)          — app code.
 *   payMyInvoiceWithDb(db, session, input, client?) — tests.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { invoice } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { computeAchPassthroughFeeCents } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { getStripeClient } from '../integrations/stripe/client.js';
import type { StripeClient } from '../integrations/stripe/client.js';
import { createPaymentIntentForInvoiceTx } from '../integrations/stripe/create-payment-intent-core.js';
import type { CreatePaymentIntentForInvoiceResult } from '../integrations/stripe/create-payment-intent-core.js';
import { loadFeePassingEnabled } from '../billing/fee-passing-internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const payMyInvoiceInputSchema = z.object({
  invoiceId: z.string().regex(UUID_RE, { message: 'invoiceId must be a UUID' }),
});

export type PayMyInvoiceInput = z.infer<typeof payMyInvoiceInputSchema>;

/**
 * The self-pay result: the shared PI-creation result, PLUS a fee breakdown on
 * the ok arm so the portal can show the member exactly what they will be
 * charged. feeCents=0 (fee-passing OFF) ⇒ chargedCents === baseCents and the
 * created PaymentIntent is byte-identical to the pre-fee-passing behavior.
 */
export type PayMyInvoiceResult =
  | (Extract<CreatePaymentIntentForInvoiceResult, { ok: true }> & {
      /** The invoice total (what the ledger credit will post on success). */
      baseCents: number;
      /** The pass-through processing fee added at checkout (0 when OFF). */
      feeCents: number;
      /** What Stripe collects = baseCents + feeCents. */
      chargedCents: number;
    })
  | Extract<CreatePaymentIntentForInvoiceResult, { ok: false }>;

async function _payMyInvoiceImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  client: StripeClient = getStripeClient(),
): Promise<PayMyInvoiceResult> {
  requireCapability(session, 'portal:access');

  const parsed = payMyInvoiceInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[portal] invalid payMyInvoice input: ${first?.message ?? 'unknown'}`);
  }
  const { invoiceId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // SELF-SCOPE FIRST: must be MY invoice, or it does not exist as far as
    // this caller is concerned (zero-IDOR — never distinguishes "not mine"
    // from "does not exist").
    const rows = await tx.select().from(invoice).where(eq(invoice.id, invoiceId)).limit(1);
    const row = rows[0];
    if (!row || row.memberUserId !== sess.userId) {
      return { ok: false, reason: 'not_found' } as const;
    }

    // Fee-passing (default OFF → feeCents=0 → byte-identical PI). When the org
    // has opted in, quote the member the grossed amount = total + fee; the
    // webhook still credits the BASE only (see create-payment-intent-core.ts).
    const feePassingEnabled = await loadFeePassingEnabled(tx, sess.orgId);
    const feeCents = feePassingEnabled ? computeAchPassthroughFeeCents(row.totalCents) : 0;

    const coreResult = await createPaymentIntentForInvoiceTx(
      tx,
      sess.orgId,
      sess.userId,
      invoiceId,
      client,
      'billing.self_pay_payment_intent_created',
      { feeCents },
    );
    if (!coreResult.ok) return coreResult;

    return {
      ...coreResult,
      baseCents: row.totalCents,
      feeCents,
      chargedCents: row.totalCents + feeCents,
    };
  });
}

export async function payMyInvoice(
  session: AppSession | null | undefined,
  input: unknown,
  client?: StripeClient,
): Promise<PayMyInvoiceResult> {
  const db = await getDb();
  return _payMyInvoiceImpl(db, session, input, client);
}

export async function payMyInvoiceWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  client?: StripeClient,
): Promise<PayMyInvoiceResult> {
  return _payMyInvoiceImpl(db, session, input, client);
}
