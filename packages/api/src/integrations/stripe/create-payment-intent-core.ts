/**
 * integrations/stripe/create-payment-intent-core.ts —
 * createPaymentIntentForInvoiceTx (Slice P0-REV).
 *
 * Extracted from create-payment-intent.ts's original implementation so BOTH
 * the staff command (createInvoicePaymentIntent, billing:manage) and the new
 * self-pay portal command (payMyInvoice, portal:access) share IDENTICAL
 * PI-creation + idempotency logic — behavior is byte-equivalent to the
 * pre-extraction inline implementation for the staff command.
 *
 * Runs on an ALREADY-OPEN, already org-scoped transaction. Callers are
 * responsible for their OWN authorization (requireCapability) and, for the
 * self-pay caller, self-scope validation (member_user_id === session.userId)
 * BEFORE calling this — this function does not itself know "who is asking",
 * only which invoice + which org.
 *
 * FLOW (unchanged from the original createInvoicePaymentIntent):
 *   1. Load the invoice — must exist and be 'finalized'.
 *   2. Idempotency: a non-terminal-failure payment_intent_record already
 *      exists for this invoice → return it verbatim, no second PaymentIntent.
 *   3. ensureStripeCustomerTx (reuse-or-create).
 *   4. Create the PaymentIntent via the client (ACH-first, staff/self-serve —
 *      NOT off-session; that path is autopay.ts's triggerAutopayOnFinalize).
 *   5. INSERT ONE payment_intent_record row (status='pending'); a losing
 *      concurrent 23505 returns the winner's record instead (RACE BACKSTOP
 *      below).
 *   6. ONE audit row, in the SAME tx (only on a winning INSERT).
 *
 * NEVER settles anything — only a verified `payment_intent.succeeded`
 * webhook (handle-webhook-event.ts) ever posts a ledger credit.
 *
 * RACE BACKSTOP (P0-REV money-invariant fix): step 2's read-then-insert
 * idempotency check is NOT atomic on its own — a concurrent caller for the
 * SAME invoice (e.g. a double self-pay click, or this racing
 * triggerAutopayOnFinalize) can pass step 2 at the same moment. The partial
 * UNIQUE index payment_intent_record_invoice_active_unique (invoice_id)
 * WHERE status IN ('pending','processing','succeeded') (migration 0023) is
 * the DB-level backstop — step 5's INSERT catches a losing 23505 and returns
 * the WINNER's already-recorded PaymentIntent (ADR-0004 catch-and-map,
 * mirrors dispatch's one-open-per-aircraft backstop) instead of creating a
 * second row, so this invoice never ends up with two trackable, settleable
 * PaymentIntents.
 */
import { eq, and, or, desc } from 'drizzle-orm';
import { invoice, paymentIntentRecord, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { getStripeClient, StripeNotConfiguredError } from './client.js';
import type { StripeClient, StripePaymentMethodType } from './client.js';
import { ensureStripeCustomerTx } from './ensure-customer.js';
import { isUniqueViolation } from '../../dispatch/internal.js';

/** ACH-first — see client.ts file header for the fee rationale. */
export const DEFAULT_PAYMENT_METHOD_TYPES: StripePaymentMethodType[] = ['us_bank_account', 'card'];

export type CreatePaymentIntentForInvoiceResult =
  | { ok: true; paymentIntentId: string; clientSecret: string; status: string; alreadyExists: boolean }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_finalized' }
  | { ok: false; reason: 'provider_error'; message: string };

function truncateErrorDetail(message: string): string {
  return message.slice(0, 500);
}

export async function createPaymentIntentForInvoiceTx(
  tx: AnyDb,
  orgId: string,
  actorUserId: string,
  invoiceId: string,
  client: StripeClient = getStripeClient(),
  auditAction: string = 'billing.stripe_payment_intent_created',
): Promise<CreatePaymentIntentForInvoiceResult> {
  // 1. Load the invoice — must exist and be finalized.
  const invoiceRows = await tx.select().from(invoice).where(eq(invoice.id, invoiceId)).limit(1);
  const invoiceRow = invoiceRows[0];
  if (!invoiceRow) {
    return { ok: false, reason: 'not_found' } as const;
  }
  if (invoiceRow.status !== 'finalized') {
    return { ok: false, reason: 'not_finalized' } as const;
  }

  // 2. Idempotency: a non-terminal-failure record already exists → return it.
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
    return {
      ok: true,
      paymentIntentId: existing.stripePaymentIntentId,
      clientSecret: '',
      status: existing.status,
      alreadyExists: true,
    } as const;
  }

  // 3. Ensure a Stripe Customer exists for the member.
  const customerResult = await ensureStripeCustomerTx(tx, orgId, invoiceRow.memberUserId, client);
  if (!customerResult.ok) {
    return customerResult;
  }
  const stripeCustomerId = customerResult.stripeCustomerId;

  // 4. Create the PaymentIntent (ACH-first, staff/self-serve — NOT off-session).
  let piResult;
  try {
    piResult = await client.createPaymentIntent({
      amountCents: invoiceRow.totalCents,
      currency: 'usd',
      customerId: stripeCustomerId,
      paymentMethodTypes: DEFAULT_PAYMENT_METHOD_TYPES,
      metadata: { invoiceId, orgId },
    });
  } catch (err) {
    if (err instanceof StripeNotConfiguredError) {
      return { ok: false, reason: 'not_configured' } as const;
    }
    const message = err instanceof Error ? err.message : 'Unknown Stripe error';
    return { ok: false, reason: 'provider_error', message: truncateErrorDetail(message) } as const;
  }

  // 5. INSERT payment_intent_record, in the SAME tx. RACE BACKSTOP: the
  //    partial UNIQUE index payment_intent_record_invoice_active_unique
  //    (invoice_id) WHERE status IN ('pending','processing','succeeded')
  //    (migration 0023) caps this invoice at ONE non-terminal record. A
  //    concurrent winner may have already inserted between step 2's SELECT
  //    and here — catch the 23505 and return THEIR record rather than a
  //    second PaymentIntent (see file header RACE BACKSTOP).
  try {
    await tx.insert(paymentIntentRecord).values({
      orgId,
      invoiceId,
      stripePaymentIntentId: piResult.stripePaymentIntentId,
      amountCents: invoiceRow.totalCents,
      paymentMethodTypes: DEFAULT_PAYMENT_METHOD_TYPES.join(','),
      status: 'pending',
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winnerRows = await tx
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
      const winner = winnerRows[0];
      if (winner) {
        return {
          ok: true,
          paymentIntentId: winner.stripePaymentIntentId,
          clientSecret: '',
          status: winner.status,
          alreadyExists: true,
        } as const;
      }
    }
    throw err;
  }

  // 6. ONE audit row (only reached when THIS call's INSERT won the race).
  await tx.insert(auditLog).values({
    orgId,
    actorUserId,
    action: auditAction,
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
}
