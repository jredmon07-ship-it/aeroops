/**
 * portal/save-payment-method.ts — saveMyPaymentMethod (Slice P0-REV, C2).
 *
 * SELF-SCOPED (portal:access): the confirm-callback primary path. After a
 * member completes a Stripe SetupIntent client-side (Stripe Element), the
 * portal calls this to attach the resulting PaymentMethod to their own
 * stripe_customer and record it. subject = session.userId ONLY — there is no
 * memberUserId/userId input parameter; self-scoping is by construction, same
 * pattern as every other portal/* command.
 *
 * IDEMPOTENT vs the setup_intent.succeeded webhook backstop (handle-webhook-
 * event.ts): ON CONFLICT (stripe_payment_method_id) DO NOTHING — whichever of
 * the two paths lands first wins; the loser is a harmless no-op.
 *
 * GUARANTEES:
 *   - authz FIRST: portal:access before any data access.
 *   - org_id + subject from session only (withSessionOrgContextWithDb).
 *   - NEVER stores raw card/bank data — only Stripe's own ids + Stripe-
 *     returned last4/brand/type DISPLAY fields (attachPaymentMethod's return
 *     shape, never client-supplied).
 *   - not_configured typed refusal on a StubStripeClient — never a crash.
 *
 * TWO CALLING FORMS:
 *   saveMyPaymentMethod(session, input)          — app code.
 *   saveMyPaymentMethodWithDb(db, session, input, client?) — tests.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { stripePaymentMethod, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { getStripeClient, StripeNotConfiguredError } from '../integrations/stripe/client.js';
import type { StripeClient } from '../integrations/stripe/client.js';
import { ensureStripeCustomerTx } from '../integrations/stripe/ensure-customer.js';

const saveMyPaymentMethodInputSchema = z.object({
  paymentMethodId: z.string().trim().min(1, { message: 'paymentMethodId is required' }),
});

export type SaveMyPaymentMethodInput = z.infer<typeof saveMyPaymentMethodInputSchema>;

export interface SavedPaymentMethodView {
  id: string;
  stripePaymentMethodId: string;
  type: 'card' | 'us_bank_account';
  last4: string | null;
  brand: string | null;
}

export type SaveMyPaymentMethodResult =
  | { ok: true; paymentMethod: SavedPaymentMethodView }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'provider_error'; message: string };

function truncateErrorDetail(message: string): string {
  return message.slice(0, 500);
}

async function _saveMyPaymentMethodImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  client: StripeClient = getStripeClient(),
): Promise<SaveMyPaymentMethodResult> {
  requireCapability(session, 'portal:access');

  const parsed = saveMyPaymentMethodInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[portal] invalid saveMyPaymentMethod input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { paymentMethodId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // SELF-SCOPED: sess.userId only.
    const customerResult = await ensureStripeCustomerTx(tx, sess.orgId, sess.userId, client);
    if (!customerResult.ok) {
      return customerResult;
    }

    let attached;
    try {
      attached = await client.attachPaymentMethod({
        paymentMethodId,
        customerId: customerResult.stripeCustomerId,
      });
    } catch (err) {
      if (err instanceof StripeNotConfiguredError) {
        return { ok: false, reason: 'not_configured' } as const;
      }
      const message = err instanceof Error ? err.message : 'Unknown Stripe error';
      return { ok: false, reason: 'provider_error', message: truncateErrorDetail(message) } as const;
    }

    // Idempotent vs the setup_intent.succeeded webhook backstop.
    const inserted = await tx
      .insert(stripePaymentMethod)
      .values({
        orgId: sess.orgId,
        userId: sess.userId,
        stripeCustomerId: customerResult.stripeCustomerId,
        stripePaymentMethodId: attached.stripePaymentMethodId,
        type: attached.type,
        last4: attached.last4,
        brand: attached.brand,
      })
      .onConflictDoNothing({ target: stripePaymentMethod.stripePaymentMethodId })
      .returning();

    let row = inserted[0];
    if (!row) {
      // The webhook backstop won the race — fetch the existing row.
      const existing = await tx
        .select()
        .from(stripePaymentMethod)
        .where(eq(stripePaymentMethod.stripePaymentMethodId, attached.stripePaymentMethodId))
        .limit(1);
      row = existing[0];
    }
    if (!row) {
      throw new Error('[portal] saveMyPaymentMethod: no stripe_payment_method row after insert/conflict');
    }

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.payment_method_saved',
      entityType: 'stripe_payment_method',
      entityId: row.id,
      metadata: {
        stripePaymentMethodId: row.stripePaymentMethodId,
        type: row.type,
      },
    });

    return {
      ok: true,
      paymentMethod: {
        id: row.id,
        stripePaymentMethodId: row.stripePaymentMethodId,
        type: row.type as 'card' | 'us_bank_account',
        last4: row.last4,
        brand: row.brand,
      },
    } as const;
  });
}

export async function saveMyPaymentMethod(
  session: AppSession | null | undefined,
  input: unknown,
  client?: StripeClient,
): Promise<SaveMyPaymentMethodResult> {
  const db = await getDb();
  return _saveMyPaymentMethodImpl(db, session, input, client);
}

export async function saveMyPaymentMethodWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  client?: StripeClient,
): Promise<SaveMyPaymentMethodResult> {
  return _saveMyPaymentMethodImpl(db, session, input, client);
}
