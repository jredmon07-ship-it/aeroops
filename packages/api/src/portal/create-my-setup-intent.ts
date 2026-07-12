/**
 * portal/create-my-setup-intent.ts — createMySetupIntent (Slice P0-REV).
 *
 * SELF-SCOPED (portal:access) variant of createInvoiceSetupIntent
 * (integrations/stripe/setup-intent-commands.ts, billing:manage/staff-
 * initiated): begins the "save a payment method for MYSELF" flow from the
 * portal. subject = session.userId ONLY — no memberUserId input parameter.
 * Shares the exact ensureStripeCustomerTx core; SetupIntent metadata carries
 * {orgId, userId: session.userId} — consumed by the setup_intent.succeeded
 * webhook backstop exactly like the staff-initiated path.
 *
 * GUARANTEES:
 *   - authz FIRST: portal:access before any data access.
 *   - org_id + subject from session only (withSessionOrgContextWithDb).
 *   - NEVER stores raw card/bank data.
 *   - not_configured typed refusal on a StubStripeClient — never a crash.
 *
 * CALLING FORM:
 *   createMySetupIntent(session, client?) — app code (client injectable for tests).
 */
import { auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { getStripeClient, StripeNotConfiguredError } from '../integrations/stripe/client.js';
import type { StripeClient } from '../integrations/stripe/client.js';
import { ensureStripeCustomerTx } from '../integrations/stripe/ensure-customer.js';
import { DEFAULT_SETUP_PAYMENT_METHOD_TYPES } from '../integrations/stripe/setup-intent-commands.js';

export type CreateMySetupIntentResult =
  | { ok: true; clientSecret: string; setupIntentId: string }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'provider_error'; message: string };

function truncateErrorDetail(message: string): string {
  return message.slice(0, 500);
}

async function _createMySetupIntentImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  client: StripeClient = getStripeClient(),
): Promise<CreateMySetupIntentResult> {
  requireCapability(session, 'portal:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const customerResult = await ensureStripeCustomerTx(tx, sess.orgId, sess.userId, client);
    if (!customerResult.ok) {
      return customerResult;
    }

    let setupResult;
    try {
      setupResult = await client.createSetupIntent({
        customerId: customerResult.stripeCustomerId,
        paymentMethodTypes: DEFAULT_SETUP_PAYMENT_METHOD_TYPES,
        metadata: { orgId: sess.orgId, userId: sess.userId },
      });
    } catch (err) {
      if (err instanceof StripeNotConfiguredError) {
        return { ok: false, reason: 'not_configured' } as const;
      }
      const message = err instanceof Error ? err.message : 'Unknown Stripe error';
      return { ok: false, reason: 'provider_error', message: truncateErrorDetail(message) } as const;
    }

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.stripe_setup_intent_created',
      entityType: 'app_user',
      entityId: sess.userId,
      metadata: { stripeSetupIntentId: setupResult.stripeSetupIntentId },
    });

    return { ok: true, clientSecret: setupResult.clientSecret, setupIntentId: setupResult.stripeSetupIntentId } as const;
  });
}

export async function createMySetupIntent(
  session: AppSession | null | undefined,
  client?: StripeClient,
): Promise<CreateMySetupIntentResult> {
  const db = await getDb();
  return _createMySetupIntentImpl(db, session, client);
}
