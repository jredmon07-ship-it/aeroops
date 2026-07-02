/**
 * integrations/stripe/autopay.ts — triggerAutopayOnFinalize (Slice P0-REV).
 *
 * Called by finalizeInvoice (billing/invoice-status-commands.ts) AFTER the
 * finalize transaction has COMMITTED (external HTTP must never be held
 * inside a DB tx). Runs its OWN fresh withSessionOrgContextWithDb.
 *
 * FLOW:
 *   1. Load autopay_setting for the invoice's member. Missing / enabled=false
 *      → 'skipped_not_enabled'. defaultPaymentMethodId null → 'skipped_no_pm'
 *      (the DB CHECK makes this unreachable when enabled=true, guarded
 *      defensively anyway).
 *   2. IDEMPOTENCY GUARD: a payment_intent_record already exists for this
 *      invoice with status IN (pending, processing, succeeded) →
 *      'skipped_existing' — NEVER a second PaymentIntent.
 *   3. Ensure a stripe_customer (reuse ensureStripeCustomerTx). Load the
 *      default PM's stripe_payment_method_id.
 *   4. client.createPaymentIntent({ ..., paymentMethodId, offSession:true,
 *      confirm:true, idempotencyKey:`autopay:<invoiceId>` }) — THREE
 *      structural layers make a double-charge impossible (see
 *      invoice-status-commands.ts's file header for the full explanation):
 *        (a) finalize is a guarded UPDATE...WHERE status='draft' (fires once)
 *        (b) step 2's existing-record check (blocks a 2nd PI for this invoice)
 *        (c) Stripe's own Idempotency-Key header (even if (a)/(b) race)
 *   5. INSERT ONE payment_intent_record (status from Stripe's response) +
 *      audit 'billing.autopay_charge_initiated'. NO LEDGER WRITE — webhooks
 *      remain the SOLE settlement path (payment_intent.succeeded posts the
 *      credit, unchanged, in handle-webhook-event.ts).
 *   RACE BACKSTOP (P0-REV money-invariant fix): step 2's read-then-insert
 *   idempotency check is NOT atomic on its own — a concurrent caller for the
 *   SAME invoice (e.g. this call racing a member's self-pay click via
 *   createPaymentIntentForInvoiceTx) can pass step 2 at the same moment. The
 *   partial UNIQUE index payment_intent_record_invoice_active_unique
 *   (invoice_id) WHERE status IN ('pending','processing','succeeded')
 *   (migration 0023) is the DB-level backstop — step 5's INSERT catches a
 *   losing 23505 and returns 'skipped_existing' (ADR-0004 catch-and-map)
 *   instead of creating a second row, so this invoice never ends up with two
 *   trackable, settleable PaymentIntents. (A losing Stripe-side PaymentIntent
 *   may still have been created by client.createPaymentIntent above — Stripe
 *   itself is not made aware of the race — but it can never post a ledger
 *   credit here: the webhook resolves org/invoice by looking up a matching
 *   payment_intent_record row, and the loser never gets one.)
 *   6. Catches:
 *        StripeNotConfiguredError → 'not_configured' (finalize already
 *          succeeded; this never fails the finalize).
 *        StripeCardDeclinedError  → record payment_intent_record status
 *          'failed' (when a PI id is present) + audit
 *          'billing.autopay_declined'; outcome 'declined'. NO credit; the
 *          member still owes.
 *        StripeProviderError (or any other) → outcome 'provider_error',
 *          logged, never thrown — the invoice stays finalized regardless.
 *
 * The invoice is ALWAYS finalized regardless of this function's outcome —
 * this is called strictly AFTER the finalize tx commits.
 */
import { eq, and, or } from 'drizzle-orm';
import { invoice, autopaySetting, stripePaymentMethod, paymentIntentRecord, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { withSessionOrgContextWithDb } from '../../auth/session.js';
import type { AppSession } from '../../auth/types.js';
import {
  getStripeClient,
  StripeNotConfiguredError,
  StripeCardDeclinedError,
  StripeProviderError,
} from './client.js';
import type { StripeClient } from './client.js';
import { ensureStripeCustomerTx } from './ensure-customer.js';
import { DEFAULT_PAYMENT_METHOD_TYPES } from './create-payment-intent-core.js';
import { isUniqueViolation } from '../../dispatch/internal.js';

export type AutopayOutcome =
  | 'created'
  | 'skipped_not_enabled'
  | 'skipped_no_pm'
  | 'skipped_existing'
  | 'not_configured'
  | 'declined'
  | 'provider_error';

export interface AutopayResult {
  outcome: AutopayOutcome;
  paymentIntentId?: string;
}

export async function triggerAutopayOnFinalize(
  db: AnyDb,
  session: AppSession,
  invoiceId: string,
  client: StripeClient = getStripeClient(),
): Promise<AutopayResult> {
  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const invoiceRows = await tx.select().from(invoice).where(eq(invoice.id, invoiceId)).limit(1);
    const invoiceRow = invoiceRows[0];
    if (!invoiceRow) {
      return { outcome: 'skipped_not_enabled' };
    }

    // 1. Load autopay_setting.
    const autopayRows = await tx
      .select()
      .from(autopaySetting)
      .where(and(eq(autopaySetting.orgId, sess.orgId), eq(autopaySetting.userId, invoiceRow.memberUserId)))
      .limit(1);
    const autopayRow = autopayRows[0];
    if (!autopayRow || !autopayRow.enabled) {
      return { outcome: 'skipped_not_enabled' };
    }
    if (!autopayRow.defaultPaymentMethodId) {
      // Unreachable under the DB CHECK (autopay_enabled_requires_pm) —
      // guarded defensively.
      return { outcome: 'skipped_no_pm' };
    }

    // 2. IDEMPOTENCY GUARD.
    const existingRows = await tx
      .select({ id: paymentIntentRecord.id })
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
      .limit(1);
    if (existingRows[0]) {
      return { outcome: 'skipped_existing' };
    }

    // 3. Ensure customer + load the default PM.
    const customerResult = await ensureStripeCustomerTx(tx, sess.orgId, invoiceRow.memberUserId, client);
    if (!customerResult.ok) {
      return { outcome: customerResult.reason === 'not_configured' ? 'not_configured' : 'provider_error' };
    }

    const pmRows = await tx
      .select()
      .from(stripePaymentMethod)
      .where(
        and(
          eq(stripePaymentMethod.id, autopayRow.defaultPaymentMethodId),
          eq(stripePaymentMethod.orgId, sess.orgId),
        ),
      )
      .limit(1);
    const pm = pmRows[0];
    if (!pm) {
      return { outcome: 'skipped_no_pm' };
    }

    // 4. Create the off-session PaymentIntent with a DETERMINISTIC
    //    idempotency key.
    const idempotencyKey = `autopay:${invoiceId}`;
    try {
      const piResult = await client.createPaymentIntent({
        amountCents: invoiceRow.totalCents,
        currency: 'usd',
        customerId: customerResult.stripeCustomerId,
        paymentMethodTypes: DEFAULT_PAYMENT_METHOD_TYPES,
        paymentMethodId: pm.stripePaymentMethodId,
        offSession: true,
        confirm: true,
        idempotencyKey,
        metadata: { invoiceId, orgId: sess.orgId },
      });

      // 5. INSERT payment_intent_record. NO LEDGER WRITE.
      //    STATUS IS ALWAYS 'processing' HERE — never 'succeeded' — even
      //    though a card charge can settle synchronously and Stripe's
      //    create response may already report status:'succeeded'. Only the
      //    verified payment_intent.succeeded WEBHOOK (handle-webhook-
      //    event.ts) is ever allowed to flip this row to 'succeeded' and
      //    post the ledger credit — webhooks are the SOLE settlement path,
      //    structurally, not just by convention: trusting the synchronous
      //    create response here would let this row's guarded UPDATE
      //    (WHERE status <> 'succeeded') silently no-op the later webhook,
      //    skipping the credit entirely.
      //    RACE BACKSTOP: the partial UNIQUE index
      //    payment_intent_record_invoice_active_unique (invoice_id) WHERE
      //    status IN ('pending','processing','succeeded') (migration 0023)
      //    caps this invoice at ONE non-terminal record — a concurrent
      //    winner (e.g. a member's self-pay click via
      //    createPaymentIntentForInvoiceTx) may have already inserted
      //    between step 2's SELECT and here. Catch the 23505 and report
      //    'skipped_existing' rather than crashing (see file header RACE
      //    BACKSTOP) — this off-session PaymentIntent (already created at
      //    Stripe above) gets no local record and therefore can never post a
      //    ledger credit.
      try {
        await tx.insert(paymentIntentRecord).values({
          orgId: sess.orgId,
          invoiceId,
          stripePaymentIntentId: piResult.stripePaymentIntentId,
          amountCents: invoiceRow.totalCents,
          paymentMethodTypes: DEFAULT_PAYMENT_METHOD_TYPES.join(','),
          status: 'processing',
        });
      } catch (insertErr) {
        if (isUniqueViolation(insertErr)) {
          return { outcome: 'skipped_existing' };
        }
        throw insertErr;
      }

      await tx.insert(auditLog).values({
        orgId: sess.orgId,
        actorUserId: null,
        action: 'billing.autopay_charge_initiated',
        entityType: 'invoice',
        entityId: invoiceId,
        metadata: {
          invoiceId,
          stripePaymentIntentId: piResult.stripePaymentIntentId,
          amountCents: invoiceRow.totalCents,
        },
      });

      return { outcome: 'created', paymentIntentId: piResult.stripePaymentIntentId };
    } catch (err) {
      if (err instanceof StripeNotConfiguredError) {
        return { outcome: 'not_configured' };
      }
      if (err instanceof StripeCardDeclinedError) {
        if (err.stripePaymentIntentId) {
          await tx.insert(paymentIntentRecord).values({
            orgId: sess.orgId,
            invoiceId,
            stripePaymentIntentId: err.stripePaymentIntentId,
            amountCents: invoiceRow.totalCents,
            paymentMethodTypes: DEFAULT_PAYMENT_METHOD_TYPES.join(','),
            status: 'failed',
          });
        }
        await tx.insert(auditLog).values({
          orgId: sess.orgId,
          actorUserId: null,
          action: 'billing.autopay_declined',
          entityType: 'invoice',
          entityId: invoiceId,
          metadata: {
            invoiceId,
            stripePaymentIntentId: err.stripePaymentIntentId ?? null,
            amountCents: invoiceRow.totalCents,
          },
        });
        return { outcome: 'declined', paymentIntentId: err.stripePaymentIntentId };
      }
      if (err instanceof StripeProviderError) {
        return { outcome: 'provider_error' };
      }
      // Never let an unexpected error escape autopay — the invoice must
      // stay finalized regardless (this fn is called AFTER finalize commits).
      return { outcome: 'provider_error' };
    }
  });
}
