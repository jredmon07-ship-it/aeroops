/**
 * integrations/stripe/ensure-customer.ts — ensureStripeCustomerTx
 * (Slice P0-REV — extracted from create-payment-intent.ts so
 * createInvoicePaymentIntent, createInvoiceSetupIntent, and
 * saveMyPaymentMethod share IDENTICAL "reuse-or-create a stripe_customer"
 * logic; behavior is byte-equivalent to the pre-extraction inline block).
 *
 * Runs on an ALREADY-OPEN, already org-scoped transaction (the caller has
 * already applied withSessionOrgContextWithDb / withOrgContext — this helper
 * NEVER sets org context itself).
 *
 * Returns { ok:true, stripeCustomerId } on success, or a typed refusal
 * ({ ok:false, reason:'not_configured' | 'provider_error', message? }) that
 * mirrors the pre-extraction inline error handling exactly — callers convert
 * these directly to their own result shapes.
 */
import { eq, and } from 'drizzle-orm';
import { appUser, stripeCustomer } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { getStripeClient, StripeNotConfiguredError } from './client.js';
import type { StripeClient } from './client.js';

export type EnsureStripeCustomerResult =
  | { ok: true; stripeCustomerId: string }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'provider_error'; message: string };

function truncateErrorDetail(message: string): string {
  return message.slice(0, 500);
}

/**
 * ensureStripeCustomerTx — reuse the member's existing stripe_customer row,
 * or create one via the client + persist it. Byte-equivalent to the original
 * inline block in createInvoicePaymentIntent.
 */
export async function ensureStripeCustomerTx(
  tx: AnyDb,
  orgId: string,
  userId: string,
  client: StripeClient = getStripeClient(),
): Promise<EnsureStripeCustomerResult> {
  const customerRows = await tx
    .select()
    .from(stripeCustomer)
    .where(and(eq(stripeCustomer.orgId, orgId), eq(stripeCustomer.userId, userId)))
    .limit(1);

  if (customerRows[0]) {
    return { ok: true, stripeCustomerId: customerRows[0].stripeCustomerId };
  }

  const memberRows = await tx
    .select({ email: appUser.email, fullName: appUser.fullName })
    .from(appUser)
    .where(eq(appUser.id, userId))
    .limit(1);
  const member = memberRows[0];

  let stripeCustomerId: string;
  try {
    const created = await client.createCustomer({
      email: member?.email ?? undefined,
      name: member?.fullName ?? undefined,
    });
    stripeCustomerId = created.stripeCustomerId;
  } catch (err) {
    if (err instanceof StripeNotConfiguredError) {
      return { ok: false, reason: 'not_configured' };
    }
    const message = err instanceof Error ? err.message : 'Unknown Stripe error';
    return { ok: false, reason: 'provider_error', message: truncateErrorDetail(message) };
  }

  await tx.insert(stripeCustomer).values({
    orgId,
    userId,
    stripeCustomerId,
  });

  return { ok: true, stripeCustomerId };
}
