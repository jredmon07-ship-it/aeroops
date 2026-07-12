/**
 * integrations/stripe/handle-webhook-event.ts — handleStripeWebhookEvent
 * (Slice B3-foundation).
 *
 * The ONLY place a Stripe webhook delivery is processed. WEBHOOKS ARE THE
 * SOURCE OF TRUTH (ADR-0015) — this is the ONLY code path that ever
 * transitions a payment_intent_record to 'succeeded' or posts a 'payment'
 * ledger credit for a Stripe-originated payment. The client-facing
 * createInvoicePaymentIntent command NEVER settles anything on its own.
 *
 * UNAUTHENTICATED CALLER (mirrors booking/submit-booking-request.ts's
 * posture): a Stripe webhook delivery carries NO AeroOps session. org_id is
 * NEVER taken from the request — it is resolved SOLELY from OUR OWN
 * payment_intent_record table via resolveOrgByStripePaymentIntentId (the
 * sanctioned platform-admin read, see resolve-payment-intent.ts), keyed by
 * the (verified) event's PaymentIntent id.
 *
 * FLOW:
 *   1. Verify the signature via client.constructWebhookEvent (throws
 *      StripeNotConfiguredError if STRIPE_WEBHOOK_SECRET unset → typed
 *      not_configured refusal; throws StripeSignatureVerificationError on
 *      any verification failure → typed invalid_signature refusal — the
 *      request is NEVER processed on either failure).
 *   2. DEDUP: INSERT INTO stripe_event (event_id = event.id, ...) FIRST.
 *      event_id is the table's PRIMARY KEY (migration 0023) — a
 *      unique-violation means this exact event was already processed; return
 *      { ok:true, alreadyProcessed:true } WITHOUT reprocessing (idempotent-
 *      by-construction, not merely an application-level check).
 *   3. If event.type !== 'payment_intent.succeeded' → dedup row written,
 *      nothing else to do (this app only acts on 'succeeded' in this slice).
 *   4. Resolve org via resolveOrgByStripePaymentIntentId. If we have no
 *      record of this PaymentIntent → nothing to credit (dedup already
 *      logged); return ok with alreadyProcessed:false.
 *   5. withOrgContext(db, resolvedOrgId, ...): a GUARDED UPDATE
 *      (WHERE status <> 'succeeded') on payment_intent_record — idempotent
 *      even if the dedup insert somehow raced (defense-in-depth; the
 *      stripe_event PK is the REAL guard). If the update fires: load the
 *      invoice's memberUserId, ensureBillingAccountTx, INSERT ONE 'payment'
 *      credit ledger_entry (createdBy=null — SYSTEM/webhook-generated,
 *      mirrors audit_log's nullable actor convention) + ONE audit row
 *      (actorUserId=null).
 *
 * GUARANTEES:
 *   - NO card/bank data anywhere in this file — only Stripe's own ids,
 *     amounts (integer cents), and status strings.
 *   - The dedup INSERT is UNCONDITIONAL — it runs even for event types this
 *     app does not otherwise act on, so a replay of ANY previously-seen
 *     event (regardless of type) is a guaranteed no-op.
 *   - Unconfigured (STRIPE_WEBHOOK_SECRET unset) → typed not_configured
 *     refusal — the route (apps/web) maps this to HTTP 503, logged loudly.
 *
 * TWO CALLING FORMS:
 *   handleStripeWebhookEvent(db, rawBody, signatureHeader)          — app code
 *     (always takes db explicitly — this is an unauthenticated route, not a
 *     session-bearing command, so there is no separate *WithDb test form;
 *     `client` is the injectable seam for tests).
 */

import { eq, and, ne } from 'drizzle-orm';
import {
  invoice,
  ledgerEntry,
  auditLog,
  stripeEvent,
  paymentIntentRecord,
  balancePayment,
  stripePaymentMethod,
  withOrgContext,
} from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { getStripeClient, StripeNotConfiguredError, StripeSignatureVerificationError } from './client.js';
import type { StripeClient } from './client.js';
import { resolveOrgByStripePaymentIntentId } from './resolve-payment-intent.js';
import { resolveBalancePaymentByStripePaymentIntentId } from './resolve-balance-payment.js';
import type { ResolvedBalancePayment } from './resolve-balance-payment.js';
import { resolveOrgByStripeCustomerId } from './resolve-payment-customer.js';
import { ensureBillingAccountTx } from '../../billing/ledger-internal.js';
import { isUniqueViolation } from '../../dispatch/internal.js';

export type HandleStripeWebhookResult =
  | { ok: true; alreadyProcessed: boolean }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'invalid_signature' };

export async function handleStripeWebhookEvent(
  db: AnyDb,
  rawBody: string,
  signatureHeader: string | null,
  client: StripeClient = getStripeClient(),
): Promise<HandleStripeWebhookResult> {
  // 1. Verify signature + parse — the ONLY trusted entry point for event data.
  let event;
  try {
    event = await client.constructWebhookEvent(rawBody, signatureHeader);
  } catch (err) {
    if (err instanceof StripeNotConfiguredError) {
      return { ok: false, reason: 'not_configured' };
    }
    if (err instanceof StripeSignatureVerificationError) {
      return { ok: false, reason: 'invalid_signature' };
    }
    // Malformed JSON / missing required fields (StripeProviderError) is also
    // treated as an untrusted payload — refuse rather than crash.
    return { ok: false, reason: 'invalid_signature' };
  }

  // 2. Best-effort org resolution BEFORE the dedup insert, so the stripe_event
  //    row's org_id is populated when we can determine it (audit/read
  //    convenience only — the dedup guarantee does not depend on this).
  let resolvedOrgId: string | null = null;
  if (event.type === 'payment_intent.succeeded') {
    const piId = (event.data.object as { id?: string }).id;
    if (piId) {
      const resolved = await resolveOrgByStripePaymentIntentId(db, piId);
      resolvedOrgId = resolved?.orgId ?? null;
    }
  } else if (event.type === 'setup_intent.succeeded') {
    // Slice P0-REV: org is resolved from OUR OWN stripe_customer table via
    // the (verified) event's `customer` id — NEVER from the payload's
    // caller-suppliable metadata (see step 3b below for the metadata
    // cross-check, which is defense-in-depth, not the authorization source).
    const customerId = (event.data.object as { customer?: string }).customer;
    if (customerId) {
      const resolved = await resolveOrgByStripeCustomerId(db, customerId);
      resolvedOrgId = resolved?.orgId ?? null;
    }
  }

  // 3. DEDUP: INSERT FIRST. event_id is the PRIMARY KEY (migration 0023) —
  //    a unique-violation means already processed. The stripe_event RLS
  //    policy admits `org_id IS NULL OR org_id = GUC` (migration 0023 §2/§6):
  //      - resolvedOrgId === null  → plain db.insert (no wrapper). The GUC is
  //        unset in this unauthenticated path, so the row's org_id MUST be
  //        NULL to satisfy the policy's first branch.
  //      - resolvedOrgId !== null  → withOrgContext(db, resolvedOrgId, ...)
  //        sets the GUC to match the row's org_id, satisfying the policy's
  //        second branch. A plain unwrapped insert with a NON-NULL org_id
  //        would be REJECTED here (GUC unset ⇒ neither branch matches).
  let alreadyProcessed = false;
  try {
    const values = {
      eventId: event.id,
      orgId: resolvedOrgId,
      type: event.type,
      payload: event as unknown as Record<string, unknown>,
    };
    if (resolvedOrgId) {
      await withOrgContext(db, resolvedOrgId, (tx) => tx.insert(stripeEvent).values(values));
    } else {
      await db.insert(stripeEvent).values(values);
    }
  } catch (err) {
    if (isUniqueViolation(err)) {
      alreadyProcessed = true;
    } else {
      throw err;
    }
  }

  if (alreadyProcessed) {
    return { ok: true, alreadyProcessed: true };
  }

  if (event.type === 'setup_intent.succeeded') {
    return handleSetupIntentSucceeded(db, event);
  }

  if (event.type !== 'payment_intent.succeeded') {
    // Recognized-but-unhandled event type: dedup logged, nothing else to do.
    return { ok: true, alreadyProcessed: false };
  }

  const piId = (event.data.object as { id?: string }).id;
  if (!piId) {
    return { ok: true, alreadyProcessed: false };
  }

  const resolved = await resolveOrgByStripePaymentIntentId(db, piId);
  if (!resolved) {
    // Not an INVOICE payment. Try the BALANCE-payment arm (additive; inert in
    // prod until migration 0045 is applied — resolveBalancePayment returns null
    // when the table is absent). Everything ABOVE this point is byte-identical
    // to the pre-fee-passing invoice-payment path.
    const balResolved = await resolveBalancePaymentByStripePaymentIntentId(db, piId);
    if (balResolved) {
      await creditBalancePayment(db, balResolved, piId);
    }
    // Whether it was a balance payment or a truly-unknown PaymentIntent, the
    // dedup row is already written; this event will never be reprocessed.
    return { ok: true, alreadyProcessed: false };
  }

  const { orgId, invoiceId, paymentIntentRecordId } = resolved;

  await withOrgContext(db, orgId, async (tx) => {
    // Guarded UPDATE WHERE status <> 'succeeded' — idempotent even if a race
    // somehow slipped past the stripe_event PK guard (defense-in-depth; the
    // PK is the REAL guarantee).
    const updated = await tx
      .update(paymentIntentRecord)
      .set({ status: 'succeeded', updatedAt: new Date() })
      .where(and(eq(paymentIntentRecord.id, paymentIntentRecordId), ne(paymentIntentRecord.status, 'succeeded')))
      .returning();

    if (!updated[0]) {
      // Already succeeded (race) — nothing further to do.
      return;
    }

    const invoiceRows = await tx
      .select({ memberUserId: invoice.memberUserId })
      .from(invoice)
      .where(eq(invoice.id, invoiceId))
      .limit(1);
    const memberUserId = invoiceRows[0]?.memberUserId;

    if (memberUserId) {
      const accountId = await ensureBillingAccountTx(tx, orgId, memberUserId);
      await tx.insert(ledgerEntry).values({
        orgId,
        accountId,
        entryType: 'payment',
        direction: 'credit',
        amountCents: updated[0].amountCents,
        invoiceId,
        paymentId: piId,
        memo: 'Stripe payment (webhook-verified)',
        createdBy: null, // SYSTEM/webhook-generated — mirrors audit_log's nullable actor convention.
      });
    }

    await tx.insert(auditLog).values({
      orgId,
      actorUserId: null,
      action: 'billing.stripe_payment_succeeded',
      entityType: 'payment_intent_record',
      entityId: paymentIntentRecordId,
      metadata: {
        invoiceId,
        stripePaymentIntentId: piId,
        amountCents: updated[0].amountCents,
      },
    });
  });

  return { ok: true, alreadyProcessed: false };
}

/**
 * creditBalancePayment — post the single 'payment' ledger credit for a verified
 * BALANCE payment (fee-passing / pay-full-balance feature). Additive: mirrors
 * the invoice-payment credit arm above, but the credit carries invoice_id=NULL
 * (a balance payment is not tied to any invoice — it simply zeroes a negative
 * ledger balance). amount_cents credited is the BASE recorded on balance_payment
 * (NOT any pass-through fee — the fee is the platform's).
 *
 * The guarded UPDATE (WHERE status <> 'succeeded') is idempotent even if a race
 * slips past the stripe_event PK dedup (defense-in-depth; the PK is the REAL
 * guard). org context is set via withOrgContext(db, resolvedOrgId) — the org_id
 * resolved from OUR OWN balance_payment table, never from the Stripe payload.
 */
async function creditBalancePayment(
  db: AnyDb,
  resolved: ResolvedBalancePayment,
  piId: string,
): Promise<void> {
  const { orgId, userId, balancePaymentId } = resolved;

  await withOrgContext(db, orgId, async (tx) => {
    const updated = await tx
      .update(balancePayment)
      .set({ status: 'succeeded', updatedAt: new Date() })
      .where(and(eq(balancePayment.id, balancePaymentId), ne(balancePayment.status, 'succeeded')))
      .returning();

    if (!updated[0]) {
      // Already succeeded (race) — nothing further to do.
      return;
    }

    const accountId = await ensureBillingAccountTx(tx, orgId, userId);
    await tx.insert(ledgerEntry).values({
      orgId,
      accountId,
      entryType: 'payment',
      direction: 'credit',
      amountCents: updated[0].amountCents,
      invoiceId: null, // balance payment — not tied to a specific invoice.
      paymentId: piId,
      memo: 'Stripe balance payment (webhook-verified)',
      createdBy: null, // SYSTEM/webhook-generated — mirrors audit_log's nullable actor.
    });

    await tx.insert(auditLog).values({
      orgId,
      actorUserId: null,
      action: 'billing.stripe_balance_payment_succeeded',
      entityType: 'balance_payment',
      entityId: balancePaymentId,
      metadata: {
        stripePaymentIntentId: piId,
        amountCents: updated[0].amountCents,
      },
    });
  });
}

/**
 * handleSetupIntentSucceeded — Slice P0-REV backstop path for
 * setup_intent.succeeded (dedup row already written by the caller before
 * this is invoked). Records the saved payment method IF it is not already
 * recorded (the confirm-callback saveMyPaymentMethod may have already won
 * the race — ON CONFLICT DO NOTHING on stripe_payment_method_id makes this
 * idempotent either way).
 *
 * org_id is resolved via resolveOrgByStripeCustomerId (step 2 above) —
 * ALREADY determined from OUR OWN stripe_customer table, never trusted from
 * the payload. `metadata.userId` (set by createInvoiceSetupIntent /
 * saveMyPaymentMethod's ensureStripeCustomerTx call) is used ONLY as a
 * cross-check against the resolved stripe_customer's own userId — a
 * mismatch means the metadata was tampered with or stale, and the write is
 * skipped (never trusted as the org/user source of truth).
 */
async function handleSetupIntentSucceeded(
  db: AnyDb,
  event: { data: { object: Record<string, unknown> } },
): Promise<HandleStripeWebhookResult> {
  const obj = event.data.object as {
    customer?: string;
    payment_method?: string;
    metadata?: { userId?: string };
  };
  const customerId = obj.customer;
  const paymentMethodId = obj.payment_method;
  if (!customerId || !paymentMethodId) {
    return { ok: true, alreadyProcessed: false };
  }

  const resolved = await resolveOrgByStripeCustomerId(db, customerId);
  if (!resolved) {
    // We have no record of this Customer — nothing to record.
    return { ok: true, alreadyProcessed: false };
  }

  // Cross-check (defense-in-depth, NOT the authorization source): if the
  // SetupIntent's metadata carries a userId, it must match the customer's
  // own recorded userId. A mismatch is treated as untrustworthy and skipped.
  if (obj.metadata?.userId && obj.metadata.userId !== resolved.userId) {
    return { ok: true, alreadyProcessed: false };
  }

  await withOrgContext(db, resolved.orgId, async (tx) => {
    await tx
      .insert(stripePaymentMethod)
      .values({
        orgId: resolved.orgId,
        userId: resolved.userId,
        stripeCustomerId: customerId,
        stripePaymentMethodId: paymentMethodId,
        // Webhook payload does not carry Stripe's display fields for this
        // event type in a stable shape across PM types — the confirm-
        // callback path (saveMyPaymentMethod, via attachPaymentMethod) is
        // the primary source for last4/brand; this backstop records the
        // linkage with type defaulted to 'card' when undetectable, refined
        // by a later saveMyPaymentMethod call if it still runs (idempotent
        // via ON CONFLICT — the row is not re-created, just left as-is).
        type: 'card',
        last4: null,
        brand: null,
      })
      .onConflictDoNothing({ target: stripePaymentMethod.stripePaymentMethodId });
  });

  return { ok: true, alreadyProcessed: false };
}
