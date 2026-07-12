/**
 * portal/pay-balance.ts — payMyBalance (fee-passing / pay-full-balance feature).
 *
 * SELF-SCOPED (portal:access): pay down the CALLER'S OWN negative ledger
 * balance directly — NOT tied to a specific invoice. subject = session.userId
 * ONLY. Creates ONE Stripe PaymentIntent for the magnitude of the balance owed
 * (grossed up by the pass-through fee when the org has fee-passing on), records
 * it in balance_payment, and lets the verified `payment_intent.succeeded`
 * webhook post the single 'payment' ledger credit for the BASE amount — which
 * naturally zeroes the negative balance (balance-based ledger). Invoice rows are
 * UNTOUCHED (statement semantics).
 *
 * GRACEFUL ABSENCE: migration 0045 (the balance_payment table) is STAGED, NOT
 * APPLIED to prod. Until a human applies it, this command returns a typed
 * { ok:false, reason:'not_available' } — never a crash — and the portal hides
 * the "Pay full balance" affordance.
 *
 * GUARANTEES:
 *   - authz FIRST: portal:access before any data access.
 *   - org_id + subject from session only (withSessionOrgContextWithDb + RLS).
 *   - NEVER posts a ledger credit — only the webhook does (sole settlement path).
 *   - NEVER stores raw card/bank data — only Stripe's own ids + integer cents.
 *   - not_configured typed refusal on a StubStripeClient — never a crash.
 *   - Soft idempotency: an existing non-terminal balance_payment for the member
 *     is returned verbatim rather than stacking a second in-flight PaymentIntent.
 *
 * TWO CALLING FORMS:
 *   payMyBalance(session, client?)          — app code.
 *   payMyBalanceWithDb(db, session, client?) — tests.
 */
import { eq, and, or, desc } from 'drizzle-orm';
import { balancePayment, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { computeBalance, computeAchPassthroughFeeCents } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { getStripeClient, StripeNotConfiguredError } from '../integrations/stripe/client.js';
import type { StripeClient } from '../integrations/stripe/client.js';
import { ensureStripeCustomerTx } from '../integrations/stripe/ensure-customer.js';
import { DEFAULT_PAYMENT_METHOD_TYPES } from '../integrations/stripe/create-payment-intent-core.js';
import { findBillingAccountTx, loadLedgerEntryAmountsTx } from '../billing/ledger-internal.js';
import {
  balancePaymentTableExists,
  loadFeePassingEnabled,
} from '../billing/fee-passing-internal.js';

export type PayMyBalanceResult =
  | {
      ok: true;
      paymentIntentId: string;
      clientSecret: string;
      status: string;
      alreadyExists: boolean;
      /** The balance magnitude paid (what the ledger credit will post). */
      baseCents: number;
      /** The pass-through processing fee added at checkout (0 when OFF). */
      feeCents: number;
      /** What Stripe collects = baseCents + feeCents. */
      chargedCents: number;
    }
  | { ok: false; reason: 'not_available' }
  | { ok: false; reason: 'no_balance_due' }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'provider_error'; message: string };

function truncateErrorDetail(message: string): string {
  return message.slice(0, 500);
}

async function _payMyBalanceImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  client: StripeClient = getStripeClient(),
): Promise<PayMyBalanceResult> {
  requireCapability(session, 'portal:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // GRACEFUL ABSENCE: the balance_payment table only exists once 0045 is
    // applied. Before any balance_payment access, degrade to not_available.
    if (!(await balancePaymentTableExists(tx))) {
      return { ok: false, reason: 'not_available' } as const;
    }

    // 1. Derive the member's balance (RLS-scoped by tx). A negative balance
    //    means the member owes money — the magnitude is what we charge.
    const accountId = await findBillingAccountTx(tx, sess.orgId, sess.userId);
    const entries = accountId ? await loadLedgerEntryAmountsTx(tx, accountId) : [];
    const balanceCents = computeBalance(entries);
    if (balanceCents >= 0) {
      return { ok: false, reason: 'no_balance_due' } as const;
    }
    const baseCents = -balanceCents; // positive magnitude owed.

    // 2. Soft idempotency: return any existing in-flight balance payment for
    //    this member rather than stacking a second PaymentIntent (a double
    //    "Pay full balance" click). 'succeeded' does NOT block a future
    //    payment — a member may owe again later.
    const existingRows = await tx
      .select()
      .from(balancePayment)
      .where(
        and(
          eq(balancePayment.userId, sess.userId),
          or(
            eq(balancePayment.status, 'pending'),
            eq(balancePayment.status, 'processing'),
          )!,
        ),
      )
      .orderBy(desc(balancePayment.createdAt))
      .limit(1);
    const existing = existingRows[0];
    if (existing) {
      return {
        ok: true,
        paymentIntentId: existing.stripePaymentIntentId,
        clientSecret: '',
        status: existing.status,
        alreadyExists: true,
        baseCents: existing.amountCents,
        feeCents: existing.feeCents,
        chargedCents: existing.amountCents + existing.feeCents,
      } as const;
    }

    // 3. Fee-passing (default OFF → feeCents=0). Gross the CHARGE only; the
    //    recorded/credited amount stays the BASE.
    const feePassingEnabled = await loadFeePassingEnabled(tx, sess.orgId);
    const feeCents = feePassingEnabled ? computeAchPassthroughFeeCents(baseCents) : 0;
    const chargeCents = baseCents + feeCents;

    // 4. Ensure a Stripe Customer exists for the member.
    const customerResult = await ensureStripeCustomerTx(tx, sess.orgId, sess.userId, client);
    if (!customerResult.ok) {
      return customerResult;
    }

    // 5. Create the PaymentIntent (ACH-first). metadata.kind='balance_payment'
    //    is how the webhook routes this to the balance-credit arm; org_id +
    //    user_id are ALSO carried but the webhook NEVER trusts them — it
    //    resolves org/member from OUR OWN balance_payment row by PI id.
    const piMetadata: Record<string, string> = {
      orgId: sess.orgId,
      userId: sess.userId,
      kind: 'balance_payment',
      baseCents: String(baseCents),
    };
    if (feeCents > 0) piMetadata['feeCents'] = String(feeCents);

    let piResult;
    try {
      piResult = await client.createPaymentIntent({
        amountCents: chargeCents,
        currency: 'usd',
        customerId: customerResult.stripeCustomerId,
        paymentMethodTypes: DEFAULT_PAYMENT_METHOD_TYPES,
        metadata: piMetadata,
      });
    } catch (err) {
      if (err instanceof StripeNotConfiguredError) {
        return { ok: false, reason: 'not_configured' } as const;
      }
      const message = err instanceof Error ? err.message : 'Unknown Stripe error';
      return { ok: false, reason: 'provider_error', message: truncateErrorDetail(message) } as const;
    }

    // 6. Record the balance_payment (status='pending'). NEVER settles — only
    //    the webhook posts the ledger credit.
    await tx.insert(balancePayment).values({
      orgId: sess.orgId,
      userId: sess.userId,
      stripePaymentIntentId: piResult.stripePaymentIntentId,
      amountCents: baseCents,
      feeCents,
      status: 'pending',
    });

    // 7. ONE audit row.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.self_pay_balance_payment_intent_created',
      entityType: 'balance_payment',
      entityId: sess.userId,
      metadata: {
        stripePaymentIntentId: piResult.stripePaymentIntentId,
        amountCents: baseCents,
        ...(feeCents > 0 ? { feeCents, chargedCents: chargeCents } : {}),
      },
    });

    return {
      ok: true,
      paymentIntentId: piResult.stripePaymentIntentId,
      clientSecret: piResult.clientSecret,
      status: piResult.status,
      alreadyExists: false,
      baseCents,
      feeCents,
      chargedCents: chargeCents,
    } as const;
  });
}

export async function payMyBalance(
  session: AppSession | null | undefined,
  client?: StripeClient,
): Promise<PayMyBalanceResult> {
  const db = await getDb();
  return _payMyBalanceImpl(db, session, client);
}

export async function payMyBalanceWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  client?: StripeClient,
): Promise<PayMyBalanceResult> {
  return _payMyBalanceImpl(db, session, client);
}
