/**
 * apps/web/app/api/integrations/stripe/webhook/route.ts
 *
 * The Stripe webhook delivery endpoint — POST only, Node runtime.
 * Stripe calls this URL directly (registered in the Stripe dashboard,
 * founder deploy step — see docs/specs/slice-b2-b3-payments.md).
 *
 * ── TRANSPORT ADAPTER ONLY ────────────────────────────────────────────────────
 * This route contains:
 *   - NO SQL
 *   - NO @aeroops/db import
 *   - NO business logic
 *
 * It delegates entirely to handleStripeWebhookEvent (@aeroops/api), which
 * owns: signature verification, event dedup (stripe_event PRIMARY KEY),
 * org resolution, the ledger credit + payment_intent_record status update +
 * audit row — all inside a single org-scoped transaction.
 *
 * ── RAW BODY REQUIREMENT (non-negotiable) ────────────────────────────────────
 * Stripe signature verification requires the EXACT, byte-for-byte raw request
 * body — NOT a re-serialized `JSON.stringify(await request.json())`, which
 * can reorder keys / change whitespace and invalidate the signature. This
 * route reads `request.text()` (the raw body string) and passes it straight
 * through to handleStripeWebhookEvent — it never calls `request.json()`.
 *
 * ── UNCONFIGURED → 503, LOGGED LOUDLY ────────────────────────────────────────
 * When STRIPE_WEBHOOK_SECRET is unset, handleStripeWebhookEvent returns
 * { ok:false, reason:'not_configured' }. This route maps that to HTTP 503
 * (Service Unavailable) and logs a loud server-side warning — Stripe will
 * retry a 503 automatically, so no delivery is silently dropped once the
 * founder configures the secret and redeploys.
 *
 * ── RESPONSE CODES ───────────────────────────────────────────────────────────
 *   200 — processed (or already processed — dedup is itself a success case;
 *         Stripe must NOT retry a webhook we have already handled).
 *   400 — invalid_signature (untrusted payload; Stripe will NOT retry a 4xx
 *         by default, which is correct — a forged/tampered request should
 *         never be retried).
 *   503 — not_configured (STRIPE_WEBHOOK_SECRET unset; Stripe retries).
 *
 * NO card/bank data ever passes through this route or is logged.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getDb, handleStripeWebhookEvent } from '@aeroops/api';

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Raw body — byte-exact, NEVER re-serialized JSON (see file header).
  const rawBody = await request.text();

  // 2. Stripe-Signature header.
  const signatureHeader = request.headers.get('stripe-signature');

  // 3. Delegate to the orchestrator — all verification/dedup/ledger logic lives there.
  const db = await getDb();
  const result = await handleStripeWebhookEvent(db, rawBody, signatureHeader);

  if (!result.ok) {
    if (result.reason === 'not_configured') {
      // eslint-disable-next-line no-console -- loud, intentional: a live
      // Stripe webhook delivery arrived but the endpoint secret is not set.
      console.error(
        '[stripe webhook] STRIPE_WEBHOOK_SECRET is not configured — a webhook delivery was refused. ' +
          'Set STRIPE_WEBHOOK_SECRET (see .env.example) and redeploy.',
      );
      return NextResponse.json({ ok: false, reason: 'not_configured' }, { status: 503 });
    }
    // invalid_signature — untrusted payload, never processed.
    return NextResponse.json({ ok: false, reason: 'invalid_signature' }, { status: 400 });
  }

  return NextResponse.json({ ok: true, alreadyProcessed: result.alreadyProcessed }, { status: 200 });
}
