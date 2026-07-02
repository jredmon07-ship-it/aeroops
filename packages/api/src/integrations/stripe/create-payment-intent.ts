/**
 * integrations/stripe/create-payment-intent.ts — createInvoicePaymentIntent
 * (Slice B3-foundation; Slice P0-REV extracts the shared core into
 * create-payment-intent-core.ts's createPaymentIntentForInvoiceTx — this
 * file is now a thin, BYTE-EQUIVALENT wrapper: same authz, same validation,
 * same tx boundary, same audit action name 'billing.stripe_payment_intent_created').
 *
 * Staff-initiated (billing:manage) — NOT a payer-facing self-serve flow in
 * this slice (see portal/pay-invoice.ts's payMyInvoice for the self-pay
 * portal command, which shares this SAME core).
 *
 * GUARANTEES:
 *   - authz FIRST: billing:manage before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - NEVER stores raw card/bank data.
 *   - The client_secret returned here is the ONLY thing the browser needs to
 *     complete a Stripe-hosted payment — it settles NOTHING on its own; only
 *     a verified webhook (`payment_intent.succeeded`) ever posts a ledger
 *     credit (see integrations/stripe/handle-webhook-event.ts).
 *
 * TWO CALLING FORMS:
 *   createInvoicePaymentIntent(session, input)          — app code.
 *   createInvoicePaymentIntentWithDb(db, session, input, client?) — tests
 *   (client is always injectable so tests never make a real HTTP call).
 */

import { z } from 'zod';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../../auth/session.js';
import { getDb } from '../../db.js';
import type { AppSession } from '../../auth/types.js';
import { ValidationError } from '../../scheduling/internal.js';
import { getStripeClient, StripeProviderError } from './client.js';
import type { StripeClient } from './client.js';
import {
  createPaymentIntentForInvoiceTx,
  DEFAULT_PAYMENT_METHOD_TYPES,
} from './create-payment-intent-core.js';
import type { CreatePaymentIntentForInvoiceResult } from './create-payment-intent-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createInvoicePaymentIntentInputSchema = z.object({
  invoiceId: z.string().regex(UUID_RE, { message: 'invoiceId must be a UUID' }),
});

export type CreateInvoicePaymentIntentInput = z.infer<typeof createInvoicePaymentIntentInputSchema>;

export type CreateInvoicePaymentIntentResult = CreatePaymentIntentForInvoiceResult;

async function _createInvoicePaymentIntentImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  client: StripeClient = getStripeClient(),
): Promise<CreateInvoicePaymentIntentResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:manage');

  // 2. VALIDATE input.
  const parsed = createInvoicePaymentIntentInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[stripe] invalid createInvoicePaymentIntent input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { invoiceId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) =>
    createPaymentIntentForInvoiceTx(
      tx,
      sess.orgId,
      sess.userId,
      invoiceId,
      client,
      'billing.stripe_payment_intent_created',
    ),
  );
}

export async function createInvoicePaymentIntent(
  session: AppSession | null | undefined,
  input: unknown,
  client?: StripeClient,
): Promise<CreateInvoicePaymentIntentResult> {
  const db = await getDb();
  return _createInvoicePaymentIntentImpl(db, session, input, client);
}

export async function createInvoicePaymentIntentWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  client?: StripeClient,
): Promise<CreateInvoicePaymentIntentResult> {
  return _createInvoicePaymentIntentImpl(db, session, input, client);
}

// Re-exported for callers that want to catch this narrowly without importing
// client.ts directly.
export { StripeProviderError, DEFAULT_PAYMENT_METHOD_TYPES };
