/**
 * integrations/stripe/create-payment-intent.ts — createInvoicePaymentIntent
 * (Slice B3-foundation).
 *
 * Staff-initiated (billing:manage) — NOT a payer-facing self-serve flow in
 * this slice. An operator, from the invoice detail view, creates a Stripe
 * PaymentIntent for a FINALIZED invoice so the member can complete payment
 * via Stripe-hosted fields (client_secret handed to the browser; the raw
 * card/bank entry NEVER touches this server — PCI SAQ-A).
 *
 * ACH-FIRST: payment_method_types defaults to ['us_bank_account', 'card'] —
 * see integrations/stripe/client.ts's file header for the fee rationale.
 *
 * FLOW:
 *   1. requireCapability('billing:manage') FIRST.
 *   2. Load the invoice — must be 'finalized' (draft/void refused).
 *   3. Idempotency: if a NON-terminal-failure payment_intent_record already
 *      exists for this invoice (status IN pending/processing/succeeded),
 *      return it verbatim — NO second PaymentIntent created. A prior
 *      'failed'/'canceled' record does NOT block a retry.
 *   4. Ensure a stripe_customer exists for the invoice's member (reuse or
 *      create via the client + persist).
 *   5. Create the PaymentIntent via the client (ACH-first).
 *   6. INSERT ONE payment_intent_record row (status='pending') + ONE audit
 *      row, in the SAME tx.
 *   7. On an unconfigured/stub client → clean typed { ok:false,
 *      reason:'not_configured' } — never a crash, no payment_intent_record
 *      row (nothing was attempted against a real provider).
 *
 * GUARANTEES:
 *   - authz FIRST: billing:manage before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - NEVER stores raw card/bank data — only Stripe's own ids + our own
 *     recorded amount (from the invoice total, INTEGER cents).
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
import { eq, and, or, desc } from 'drizzle-orm';
import { invoice, appUser, stripeCustomer, paymentIntentRecord, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../../auth/session.js';
import { getDb } from '../../db.js';
import type { AppSession } from '../../auth/types.js';
import { ValidationError } from '../../scheduling/internal.js';
import { getStripeClient, StripeNotConfiguredError, StripeProviderError } from './client.js';
import type { StripeClient, StripePaymentMethodType } from './client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createInvoicePaymentIntentInputSchema = z.object({
  invoiceId: z.string().regex(UUID_RE, { message: 'invoiceId must be a UUID' }),
});

export type CreateInvoicePaymentIntentInput = z.infer<typeof createInvoicePaymentIntentInputSchema>;

/** ACH-first — see client.ts file header for the fee rationale. */
export const DEFAULT_PAYMENT_METHOD_TYPES: StripePaymentMethodType[] = ['us_bank_account', 'card'];

export type CreateInvoicePaymentIntentResult =
  | { ok: true; paymentIntentId: string; clientSecret: string; status: string; alreadyExists: boolean }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_finalized' }
  | { ok: false; reason: 'provider_error'; message: string };

function truncateErrorDetail(message: string): string {
  return message.slice(0, 500);
}

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

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load the invoice — must exist and be finalized.
    const invoiceRows = await tx.select().from(invoice).where(eq(invoice.id, invoiceId)).limit(1);
    const invoiceRow = invoiceRows[0];
    if (!invoiceRow) {
      return { ok: false, reason: 'not_found' } as const;
    }
    if (invoiceRow.status !== 'finalized') {
      return { ok: false, reason: 'not_finalized' } as const;
    }

    // 4. Idempotency: a non-terminal-failure record already exists → return it.
    const existingRows = await tx
      .select()
      .from(paymentIntentRecord)
      .where(
        and(
          eq(paymentIntentRecord.invoiceId, invoiceId),
          or(
            eq(paymentIntentRecord.status, 'pending'),
            eq(paymentIntentRecord.status, 'processing'),
            eq(paymentIntentRecord.status, 'succeeded'),
          )!,
        ),
      )
      .orderBy(desc(paymentIntentRecord.createdAt))
      .limit(1);

    const existing = existingRows[0];
    if (existing) {
      // We do not have Stripe's client_secret cached — a fresh retrieve is
      // NOT performed here (client_secret is a one-time-issued value the
      // browser already has from the original creation; re-fetching status
      // is getPaymentStatus's job). Return what we have; the caller's UI
      // should already hold the client_secret from the first response.
      return {
        ok: true,
        paymentIntentId: existing.stripePaymentIntentId,
        clientSecret: '',
        status: existing.status,
        alreadyExists: true,
      } as const;
    }

    // 5. Ensure a Stripe Customer exists for the member.
    let stripeCustomerId: string;
    const customerRows = await tx
      .select()
      .from(stripeCustomer)
      .where(and(eq(stripeCustomer.orgId, sess.orgId), eq(stripeCustomer.userId, invoiceRow.memberUserId)))
      .limit(1);

    if (customerRows[0]) {
      stripeCustomerId = customerRows[0].stripeCustomerId;
    } else {
      const memberRows = await tx
        .select({ email: appUser.email, fullName: appUser.fullName })
        .from(appUser)
        .where(eq(appUser.id, invoiceRow.memberUserId))
        .limit(1);
      const member = memberRows[0];

      try {
        const created = await client.createCustomer({
          email: member?.email ?? undefined,
          name: member?.fullName ?? undefined,
        });
        stripeCustomerId = created.stripeCustomerId;
      } catch (err) {
        if (err instanceof StripeNotConfiguredError) {
          return { ok: false, reason: 'not_configured' } as const;
        }
        const message = err instanceof Error ? err.message : 'Unknown Stripe error';
        return { ok: false, reason: 'provider_error', message: truncateErrorDetail(message) } as const;
      }

      await tx.insert(stripeCustomer).values({
        orgId: sess.orgId,
        userId: invoiceRow.memberUserId,
        stripeCustomerId,
      });
    }

    // 6. Create the PaymentIntent (ACH-first).
    let piResult;
    try {
      piResult = await client.createPaymentIntent({
        amountCents: invoiceRow.totalCents,
        currency: 'usd',
        customerId: stripeCustomerId,
        paymentMethodTypes: DEFAULT_PAYMENT_METHOD_TYPES,
        metadata: { invoiceId, orgId: sess.orgId },
      });
    } catch (err) {
      if (err instanceof StripeNotConfiguredError) {
        return { ok: false, reason: 'not_configured' } as const;
      }
      const message = err instanceof Error ? err.message : 'Unknown Stripe error';
      return { ok: false, reason: 'provider_error', message: truncateErrorDetail(message) } as const;
    }

    // 7. INSERT payment_intent_record + audit, in the SAME tx.
    await tx.insert(paymentIntentRecord).values({
      orgId: sess.orgId,
      invoiceId,
      stripePaymentIntentId: piResult.stripePaymentIntentId,
      amountCents: invoiceRow.totalCents,
      paymentMethodTypes: DEFAULT_PAYMENT_METHOD_TYPES.join(','),
      status: 'pending',
    });

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.stripe_payment_intent_created',
      entityType: 'invoice',
      entityId: invoiceId,
      metadata: {
        invoiceId,
        stripePaymentIntentId: piResult.stripePaymentIntentId,
        amountCents: invoiceRow.totalCents,
        paymentMethodTypes: DEFAULT_PAYMENT_METHOD_TYPES,
      },
    });

    return {
      ok: true,
      paymentIntentId: piResult.stripePaymentIntentId,
      clientSecret: piResult.clientSecret,
      status: piResult.status,
      alreadyExists: false,
    } as const;
  });
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
export { StripeProviderError };
