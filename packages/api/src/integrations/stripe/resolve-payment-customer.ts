/**
 * integrations/stripe/resolve-payment-customer.ts — platform-scoped
 * stripe_customer_id → org lookup (Slice P0-REV — the setup_intent.succeeded
 * webhook path only).
 *
 * SANCTIONED PLATFORM-ADMIN READ (mirrors resolve-payment-intent.ts's
 * resolveOrgByStripePaymentIntentId exactly — same justification, a
 * DIFFERENT unauthenticated entry point):
 *   resolveOrgByStripeCustomerId is permitted to use withPlatformAdminContext
 *   because it is:
 *     - Read-only (SELECT only — no mutation).
 *     - Single-row result with a FIXED projection {orgId, userId}.
 *     - Keyed by exact match on stripe_customer_id (globally UNIQUE —
 *       migration 0023's stripe_customer_stripe_id_unique).
 *     - Called exclusively from the setup_intent.succeeded webhook handler,
 *       BEFORE any org context can be established.
 *
 *   Backed by migration 0024's stripe_customer_select policy replacement
 *   (adds a platform-admin SELECT branch, mirroring
 *   payment_intent_record_select's precedent from migration 0023).
 *
 *   Every subsequent write happens ONLY inside withOrgContext(db,
 *   resolvedOrgId, ...) — org_id THIS function resolved from OUR OWN table,
 *   NEVER trusted blindly from the webhook payload's caller-suppliable
 *   metadata (which is validated as a CROSS-CHECK, not an authorization
 *   source — see handle-webhook-event.ts).
 *
 * This function is framework-agnostic; it does not import next/Stripe SDK.
 */
import { eq } from 'drizzle-orm';
import { withPlatformAdminContext, stripeCustomer } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';

export interface ResolvedStripeCustomer {
  orgId: string;
  userId: string;
}

/**
 * resolveOrgByStripeCustomerId — looks up which org (and which member) a
 * Stripe Customer id belongs to. Returns null if we have no record of this
 * customer id (e.g. a foreign/stale test event) — the webhook handler treats
 * this as "nothing to record", NOT an error.
 */
export async function resolveOrgByStripeCustomerId(
  db: AnyDb,
  stripeCustomerId: string,
): Promise<ResolvedStripeCustomer | null> {
  const rows = await withPlatformAdminContext(db, (tx) =>
    tx
      .select({ orgId: stripeCustomer.orgId, userId: stripeCustomer.userId })
      .from(stripeCustomer)
      .where(eq(stripeCustomer.stripeCustomerId, stripeCustomerId))
      .limit(1),
  );

  const row = rows[0];
  if (!row) return null;
  return { orgId: row.orgId, userId: row.userId };
}
