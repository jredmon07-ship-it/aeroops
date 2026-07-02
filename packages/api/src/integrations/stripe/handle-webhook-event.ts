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
import { invoice, ledgerEntry, auditLog, stripeEvent, paymentIntentRecord, withOrgContext } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { getStripeClient, StripeNotConfiguredError, StripeSignatureVerificationError } from './client.js';
import type { StripeClient } from './client.js';
import { resolveOrgByStripePaymentIntentId } from './resolve-payment-intent.js';
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
    // We have no record of this PaymentIntent — nothing to credit. The
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
