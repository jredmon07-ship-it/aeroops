/**
 * integrations/stripe/resolve-payment-intent.ts — platform-scoped
 * PaymentIntent → org lookup (Stripe webhook path only, Slice B3-foundation).
 *
 * SANCTIONED PLATFORM-ADMIN READ (mirrors auth/resolve-org.ts's
 * resolveOrgBySlug exactly — same justification, a DIFFERENT unauthenticated
 * entry point):
 *   resolveOrgByStripePaymentIntentId is the ONLY function in the Stripe
 *   webhook path that is permitted to use withPlatformAdminContext. It is:
 *     - Read-only (SELECT only — no mutation).
 *     - Single-row result with a FIXED projection {orgId, invoiceId,
 *       paymentIntentRecordId}.
 *     - Keyed by exact match on stripe_payment_intent_id (globally UNIQUE —
 *       migration 0023's payment_intent_record_stripe_pi_unique).
 *     - Called exclusively from the webhook handler, BEFORE any org context
 *       can be established (a Stripe webhook delivery carries no AeroOps
 *       session; the caller-supplied PaymentIntent id is the ONLY handle we
 *       have to find which org this event belongs to).
 *
 *   Every subsequent write (the ledger credit + payment_intent_record status
 *   update + audit row) happens ONLY inside withOrgContext(db, resolvedOrgId, ...)
 *   — the normal per-tenant choke-point — using the org_id THIS function
 *   resolved from OUR OWN table, never from the Stripe payload's metadata
 *   (which is caller-suppliable at PaymentIntent-creation time and must not
 *   be trusted as an authorization boundary).
 *
 * This function is framework-agnostic; it does not import next/Stripe SDK.
 */
import { eq } from 'drizzle-orm';
import { withPlatformAdminContext, paymentIntentRecord } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';

export interface ResolvedPaymentIntent {
  orgId: string;
  invoiceId: string;
  paymentIntentRecordId: string;
}

/**
 * resolveOrgByStripePaymentIntentId — looks up which org (and which of our
 * own payment_intent_record rows) a Stripe PaymentIntent id belongs to.
 *
 * Returns null if we have no record of this PaymentIntent id (e.g. an event
 * for a PaymentIntent this app never created, or a stale/foreign test event)
 * — the webhook handler treats this as "nothing to credit", NOT an error.
 *
 * @param db                    The Drizzle database client (prod or test).
 * @param stripePaymentIntentId Stripe's own PaymentIntent id (e.g. "pi_...").
 */
export async function resolveOrgByStripePaymentIntentId(
  db: AnyDb,
  stripePaymentIntentId: string,
): Promise<ResolvedPaymentIntent | null> {
  const rows = await withPlatformAdminContext(db, (tx) =>
    tx
      .select({
        orgId: paymentIntentRecord.orgId,
        invoiceId: paymentIntentRecord.invoiceId,
        id: paymentIntentRecord.id,
      })
      .from(paymentIntentRecord)
      .where(eq(paymentIntentRecord.stripePaymentIntentId, stripePaymentIntentId))
      .limit(1),
  );

  const row = rows[0];
  if (!row) return null;
  return { orgId: row.orgId, invoiceId: row.invoiceId, paymentIntentRecordId: row.id };
}
