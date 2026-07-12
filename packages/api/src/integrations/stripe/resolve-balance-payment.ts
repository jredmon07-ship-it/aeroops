/**
 * integrations/stripe/resolve-balance-payment.ts — platform-scoped
 * PaymentIntent → (org, member) lookup for BALANCE payments (Stripe webhook
 * path only, fee-passing / pay-full-balance feature).
 *
 * SANCTIONED PLATFORM-ADMIN READ (mirrors resolveOrgByStripePaymentIntentId
 * exactly — same justification, the balance_payment table instead of
 * payment_intent_record):
 *   resolveBalancePaymentByStripePaymentIntentId is permitted to use
 *   withPlatformAdminContext. It is read-only, single-row, keyed by exact match
 *   on the globally-UNIQUE stripe_payment_intent_id, and called only from the
 *   webhook handler BEFORE any org context can be established. Every subsequent
 *   write (the ledger credit + status update + audit) happens ONLY inside
 *   withOrgContext(db, resolvedOrgId, ...) using the org_id THIS function
 *   resolved from OUR OWN table — never from the Stripe payload's metadata.
 *
 * GRACEFUL ABSENCE: migration 0045 (balance_payment) is STAGED, NOT APPLIED to
 * prod. When the table is absent, this returns null (no crash) — so the webhook
 * balance arm is inert until a human applies 0045, and existing invoice-payment
 * settlement is entirely unaffected.
 */
import { eq } from 'drizzle-orm';
import { withPlatformAdminContext, balancePayment } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { balancePaymentTableExists } from '../../billing/fee-passing-internal.js';

export interface ResolvedBalancePayment {
  orgId: string;
  userId: string;
  balancePaymentId: string;
  amountCents: number;
}

/**
 * resolveBalancePaymentByStripePaymentIntentId — which (org, member) a Stripe
 * PaymentIntent id belongs to, for a BALANCE payment. Returns null when the
 * balance_payment table is absent (0045 unapplied) OR we have no record of this
 * PaymentIntent id (e.g. an invoice payment, or a foreign/stale event).
 */
export async function resolveBalancePaymentByStripePaymentIntentId(
  db: AnyDb,
  stripePaymentIntentId: string,
): Promise<ResolvedBalancePayment | null> {
  // Catalog-only existence check (no org context needed) — inert until 0045.
  if (!(await balancePaymentTableExists(db))) return null;

  const rows = await withPlatformAdminContext(db, (tx) =>
    tx
      .select({
        orgId: balancePayment.orgId,
        userId: balancePayment.userId,
        id: balancePayment.id,
        amountCents: balancePayment.amountCents,
      })
      .from(balancePayment)
      .where(eq(balancePayment.stripePaymentIntentId, stripePaymentIntentId))
      .limit(1),
  );

  const row = rows[0];
  if (!row) return null;
  return {
    orgId: row.orgId,
    userId: row.userId,
    balancePaymentId: row.id,
    amountCents: row.amountCents,
  };
}
