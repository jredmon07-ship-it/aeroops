/**
 * apps/web/app/api/public/booking/[slug]/route.ts
 *
 * Public booking-request submit endpoint — POST only, Node runtime.
 *
 * ── TRANSPORT ADAPTER ONLY (ADR-0013) ───────────────────────────────────────
 * This route contains:
 *   - NO SQL
 *   - NO @aeroops/db import
 *   - NO business logic
 *
 * It delegates entirely to submitBookingRequest (in @aeroops/api), which owns:
 *   - honeypot check
 *   - CAPTCHA verify (PB-LR.B seam — Noop when unconfigured, byte-identical)
 *   - zod validation
 *   - org resolve + active gate (resolveOrgBySlug)
 *   - per-org rate guard
 *   - the booking_request INSERT (inside withOrgContext, RLS backstop)
 *
 * ── SECURITY INVARIANTS (ADR-0013) ───────────────────────────────────────────
 *   - The slug comes from the URL path params (params.slug), NEVER from the
 *     request body. The body has no org_id or slug field.
 *   - Malformed JSON body → generic { ok:false } (not a 400 with field detail).
 *   - All responses are 200 JSON; the ok/reason fields carry the semantic result.
 *     We use HTTP 200 for both success and application-layer errors to avoid
 *     leaking information through HTTP status codes.
 *   - Never returns a tenant id, org name, or any internal detail.
 *
 * ── CAPTCHA (PB-LR.B) ────────────────────────────────────────────────────────
 *   - Best-effort client IP is read from x-forwarded-for (first entry) and
 *     passed to submitBookingRequest as remoteIp. It is NEVER stored or logged
 *     alongside any PII — the orchestrator passes it to the verifier only.
 *   - When CAPTCHA is unconfigured (CAPTCHA_PROVIDER/CAPTCHA_SECRET_KEY absent),
 *     the NoopCaptchaVerifier is used and remoteIp is effectively a no-op.
 *
 * ── ACCESSIBLE VIA MIDDLEWARE ─────────────────────────────────────────────────
 * /api/public/booking/* is NOT under /o/[slug]/* so it passes through the
 * existing middleware without hitting the session check. apps/web/middleware.ts
 * has an explicit allowance comment for this path (ADR-0013).
 *
 * [VERIFY-PB1-SEC-1]: edge rate-limiter + WAF + CAPTCHA before public exposure.
 * PB-LR.B seam is code-complete; the WAF + provider keys are the founder deploy step.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getDb, submitBookingRequest } from '@aeroops/api';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  // 1. Parse JSON body.
  //    Malformed JSON → generic { ok:false } (no field detail, no HTTP error code).
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 200 });
  }

  // 2. Extract the org slug from the URL path (NEVER from the body).
  const { slug } = await params;

  // 3. Best-effort client IP for the CAPTCHA verifier (PB-LR.B).
  //    x-forwarded-for may be a comma-separated list; take the first entry.
  //    NEVER stored, NEVER logged with any PII — passed to the verifier only.
  const xForwardedFor = request.headers.get('x-forwarded-for');
  const remoteIp = xForwardedFor ? xForwardedFor.split(',')[0]?.trim() : undefined;

  // 4. Get the production DB client.
  const db = await getDb();

  // 5. Delegate to the orchestrator — all security logic lives there.
  //    The orchestrator:
  //      (a) checks honeypot
  //      (a2) CAPTCHA verify (PB-LR.B — Noop when unconfigured, byte-identical)
  //      (b) validates with bookingRequestSchema
  //      (c) resolves org + active gate
  //      (d) runs the withOrgContext INSERT (RLS backstop)
  //    It returns { ok:true } or { ok:false, reason:'invalid'|'unavailable' }.
  //    verifier defaults to getCaptchaVerifier() inside submitBookingRequest.
  const result = await submitBookingRequest(db, slug, body, undefined, remoteIp);

  // 6. Return result as JSON.
  //    HTTP 200 for all outcomes — semantic result is in the body.
  return NextResponse.json(result, { status: 200 });
}
