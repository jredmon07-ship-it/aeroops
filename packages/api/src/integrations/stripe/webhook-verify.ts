/**
 * integrations/stripe/webhook-verify.ts — Stripe webhook signature
 * verification (Slice B3-foundation).
 *
 * PURE + framework-agnostic: no fetch, no DB, no Next.js. Verified against
 * Stripe's own documented algorithm (docs.stripe.com/webhooks/signatures,
 * confirmed 2026-07):
 *
 *   1. The `Stripe-Signature` header is a comma-separated list of
 *      `key=value` pairs: `t=<unix-seconds>,v1=<hex-hmac>[,v0=<legacy>]`.
 *      Only `v1` schemes are ever trusted (v0 is a legacy/test scheme —
 *      accepting it would be a downgrade-attack vector). Stripe may send
 *      MULTIPLE `v1=` pairs during a secret rotation window — a payload is
 *      valid if it matches ANY of them.
 *   2. signed_payload = "{t}.{raw_request_body}" (the RAW, byte-exact body —
 *      NEVER a re-serialized/parsed-then-stringified JSON value).
 *   3. expected_signature = HMAC-SHA256(key = webhook_secret, message = signed_payload),
 *      hex-encoded.
 *   4. Compare each `v1` value to `expected_signature` using a CONSTANT-TIME
 *      comparison (crypto.timingSafeEqual) — never `===` (timing-attack safe).
 *   5. Reject if `|now - t| > toleranceSeconds` (replay protection). Stripe's
 *      own libraries default to a 300-second (5-minute) tolerance; NEVER use
 *      a tolerance of 0 (that disables replay protection entirely).
 *
 * NON-NEGOTIABLE (per CLAUDE.md + the B3 task): this file is the ONLY place
 * webhook signatures are computed. NO card/bank/PAN data ever passes through
 * here — this verifies a MESSAGE AUTHENTICATION CODE over the request body,
 * never a payment instrument.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type VerifyStripeSignatureResult =
  | { ok: true }
  | { ok: false; reason: 'missing_header' }
  | { ok: false; reason: 'malformed_header' }
  | { ok: false; reason: 'no_v1_signature' }
  | { ok: false; reason: 'signature_mismatch' }
  | { ok: false; reason: 'timestamp_too_old' };

export interface VerifyStripeSignatureOptions {
  /** Replay-protection tolerance, in seconds. Default 300 (Stripe's own default). */
  toleranceSeconds?: number;
  /** Injectable "now", in EPOCH SECONDS (not ms) — for deterministic tests. Default Date.now()/1000. */
  nowSeconds?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * parseStripeSignatureHeader — splits the header into { timestamp, v1Signatures }.
 * Returns null on a header with no `t=` field or no `v1=` fields at all
 * (distinct malformed-vs-missing-scheme reasons are surfaced by the caller).
 */
function parseStripeSignatureHeader(
  header: string,
): { timestampStr: string | undefined; v1Signatures: string[] } {
  const parts = header.split(',').map((p) => p.trim());
  let timestampStr: string | undefined;
  const v1Signatures: string[] = [];

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 't') {
      timestampStr = value;
    } else if (key === 'v1') {
      // Multiple v1 pairs are valid (secret-rotation window) — collect all.
      v1Signatures.push(value);
    }
    // 'v0' (legacy) and any unknown scheme are intentionally ignored — only
    // v1 is ever trusted (downgrade-attack protection).
  }

  return { timestampStr, v1Signatures };
}

/**
 * verifyStripeSignature — verify a Stripe webhook request against its
 * `Stripe-Signature` header + your endpoint's signing secret.
 *
 * @param rawBody         The RAW (unparsed) request body string — byte-exact
 *                         as received. NEVER JSON.stringify(JSON.parse(body))
 *                         first; that can change whitespace/key order and
 *                         invalidate the signature.
 * @param signatureHeader  The `Stripe-Signature` request header value, or
 *                         null/undefined if absent.
 * @param webhookSecret    Your endpoint's `whsec_...` signing secret.
 * @param options          Optional tolerance + injectable "now" for tests.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  webhookSecret: string,
  options: VerifyStripeSignatureOptions = {},
): VerifyStripeSignatureResult {
  if (!signatureHeader) {
    return { ok: false, reason: 'missing_header' };
  }

  const { timestampStr, v1Signatures } = parseStripeSignatureHeader(signatureHeader);

  if (!timestampStr || !/^\d+$/.test(timestampStr)) {
    return { ok: false, reason: 'malformed_header' };
  }
  if (v1Signatures.length === 0) {
    return { ok: false, reason: 'no_v1_signature' };
  }

  const timestamp = Number(timestampStr);
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  // Replay protection FIRST (cheap check before the HMAC compute) — a stale
  // timestamp is rejected regardless of whether the signature would match.
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp_too_old' };
  }

  const signedPayload = `${timestampStr}.${rawBody}`;
  const expectedHex = createHmac('sha256', webhookSecret).update(signedPayload, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');

  // Constant-time comparison against EACH provided v1 signature — valid if
  // ANY matches (Stripe sends multiple during a secret-rotation window).
  for (const candidate of v1Signatures) {
    // A malformed (non-hex or wrong-length) candidate must not throw or leak
    // timing information — guard the length before calling timingSafeEqual
    // (which requires equal-length buffers).
    if (!/^[0-9a-f]+$/i.test(candidate) || candidate.length !== expectedHex.length) {
      continue;
    }
    const candidateBuf = Buffer.from(candidate, 'hex');
    if (candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: 'signature_mismatch' };
}
