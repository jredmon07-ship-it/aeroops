/**
 * integrations/stripe/setup-intent-commands.ts — createInvoiceSetupIntent
 * (Slice P0-REV, C1).
 *
 * Staff-initiated (billing:manage): begins the "save a payment method for
 * this member" flow. Ensures a stripe_customer exists, then requests a
 * SetupIntent (client_secret handed to the browser for a Stripe Element —
 * the raw card/bank entry NEVER touches this server, PCI SAQ-A). SetupIntent
 * metadata carries {orgId,userId} — consumed by the setup_intent.succeeded
 * webhook backstop (handle-webhook-event.ts) to resolve which member a
 * successful setup belongs to WITHOUT trusting it as the sole source of
 * truth (the webhook independently resolves org via
 * resolveOrgByStripeCustomerId and only uses metadata.userId as a
 * cross-check — see that file).
 *
 * The confirm-callback primary path (portal/save-payment-method.ts's
 * saveMyPaymentMethod) is what actually records the stripe_payment_method
 * row after the member completes the SetupIntent client-side; the webhook is
 * a backstop for the case where the confirm-callback never fires (browser
 * closed, network drop, etc).
 *
 * GUARANTEES:
 *   - authz FIRST: billing:manage before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - NEVER stores raw card/bank data.
 *   - not_configured typed refusal on a StubStripeClient — never a crash.
 *
 * TWO CALLING FORMS:
 *   createInvoiceSetupIntent(session, input)          — app code.
 *   createInvoiceSetupIntentWithDb(db, session, input, client?) — tests.
 */
import { z } from 'zod';
import { membership, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import { requireCapability } from '../../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../../auth/session.js';
import { getDb } from '../../db.js';
import type { AppSession } from '../../auth/types.js';
import { ValidationError } from '../../scheduling/internal.js';
import { getStripeClient, StripeNotConfiguredError } from './client.js';
import type { StripeClient, StripePaymentMethodType } from './client.js';
import { ensureStripeCustomerTx } from './ensure-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createInvoiceSetupIntentInputSchema = z.object({
  memberUserId: z.string().regex(UUID_RE, { message: 'memberUserId must be a UUID' }),
});

export type CreateInvoiceSetupIntentInput = z.infer<typeof createInvoiceSetupIntentInputSchema>;

/** Reused for SetupIntents — same ACH-first posture as PaymentIntents. */
export const DEFAULT_SETUP_PAYMENT_METHOD_TYPES: StripePaymentMethodType[] = ['us_bank_account', 'card'];

export type CreateInvoiceSetupIntentResult =
  | { ok: true; clientSecret: string; setupIntentId: string }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'member_not_found' }
  | { ok: false; reason: 'provider_error'; message: string };

function truncateErrorDetail(message: string): string {
  return message.slice(0, 500);
}

async function _createInvoiceSetupIntentImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  client: StripeClient = getStripeClient(),
): Promise<CreateInvoiceSetupIntentResult> {
  requireCapability(session, 'billing:manage');

  const parsed = createInvoiceSetupIntentInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[stripe] invalid createInvoiceSetupIntent input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { memberUserId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const memberRows = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(and(eq(membership.userId, memberUserId), eq(membership.orgId, sess.orgId)))
      .limit(1);
    if (!memberRows[0]) {
      return { ok: false, reason: 'member_not_found' } as const;
    }

    const customerResult = await ensureStripeCustomerTx(tx, sess.orgId, memberUserId, client);
    if (!customerResult.ok) {
      return customerResult;
    }

    let setupResult;
    try {
      setupResult = await client.createSetupIntent({
        customerId: customerResult.stripeCustomerId,
        paymentMethodTypes: DEFAULT_SETUP_PAYMENT_METHOD_TYPES,
        metadata: { orgId: sess.orgId, userId: memberUserId },
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
      entityId: memberUserId,
      metadata: {
        memberUserId,
        stripeSetupIntentId: setupResult.stripeSetupIntentId,
      },
    });

    return { ok: true, clientSecret: setupResult.clientSecret, setupIntentId: setupResult.stripeSetupIntentId } as const;
  });
}

export async function createInvoiceSetupIntent(
  session: AppSession | null | undefined,
  input: unknown,
  client?: StripeClient,
): Promise<CreateInvoiceSetupIntentResult> {
  const db = await getDb();
  return _createInvoiceSetupIntentImpl(db, session, input, client);
}

export async function createInvoiceSetupIntentWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  client?: StripeClient,
): Promise<CreateInvoiceSetupIntentResult> {
  return _createInvoiceSetupIntentImpl(db, session, input, client);
}
