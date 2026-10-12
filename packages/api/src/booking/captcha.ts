/**
 * booking/captcha.ts — CAPTCHA verification seam (Slice PB-LR.B / ADR-0013).
 *
 * ── ADR-0013 INVARIANTS (unchanged) ─────────────────────────────────────────
 *   - The verifier runs OUTSIDE the withOrgContext tx (zero DB access on a drop).
 *   - verify() is called AFTER the honeypot check, BEFORE org-resolve + tx.
 *   - On verify()===false → same { ok:true } silent-drop as honeypot (anti-enum).
 *   - On verifier THROW → fail-OPEN (catch → allow; provider outage must NOT kill
 *     lead capture). Log server-side with NO PII.
 *   - When unconfigured (default) → NoopCaptchaVerifier → verify() always true →
 *     the path is BYTE-IDENTICAL to the pre-PB-LR.B submit (existing tests green).
 *
 * ── PROVIDER SEAM ─────────────────────────────────────────────────────────────
 *   getCaptchaVerifier() reads CAPTCHA_PROVIDER + CAPTCHA_SECRET_KEY from env:
 *     - Both unset    → NoopCaptchaVerifier (default — no CAPTCHA in the path).
 *     - 'turnstile' + key set → TurnstileCaptchaVerifier (Cloudflare Turnstile).
 *     - Key absent    → NoopCaptchaVerifier (missing config treated as unconfigured).
 *   The factory is called once per request (not cached globally) so env updates
 *   in tests take effect immediately.
 *
 * ── DEPLOY STEP ───────────────────────────────────────────────────────────────
 *   This file is the IN-APP seam. The actual CAPTCHA activation is a maintainer
 *   deploy step — see docs/launch/public-booking-launch.md:
 *     Set CAPTCHA_PROVIDER=turnstile + CAPTCHA_SECRET_KEY=<secret> (server-side)
 *     Set NEXT_PUBLIC_CAPTCHA_SITE_KEY=<site-key> (public, in Vercel env vars).
 *   The seam activates automatically; no code change required.
 *
 * NO money, NO FAA determination.
 */

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * CaptchaVerifier — the abstraction boundary for CAPTCHA verification.
 *
 * Implementations:
 *   - NoopCaptchaVerifier  → always true (default when unconfigured).
 *   - TurnstileCaptchaVerifier → Cloudflare Turnstile siteverify HTTP call.
 *
 * CONTRACT:
 *   - Returns true  → request is allowed to proceed.
 *   - Returns false → silent drop ({ ok:true } anti-enumeration, no DB access).
 *   - Throws        → caller MUST catch and fail-OPEN (provider outage safety).
 */
export interface CaptchaVerifier {
  /**
   * Verify a CAPTCHA response token.
   *
   * @param token    - The client-supplied CAPTCHA token (undefined when absent).
   * @param remoteIp - Best-effort client IP for the provider (never stored/logged).
   * @returns true to allow; false to silent-drop.
   * @throws On provider errors — CALLER must catch and fail-OPEN.
   */
  verify(token: string | undefined, remoteIp?: string): Promise<boolean>;
}

// ─── Noop (default — unconfigured) ───────────────────────────────────────────

/**
 * NoopCaptchaVerifier — the DEFAULT implementation.
 *
 * Always returns true. Used when CAPTCHA is not configured (CAPTCHA_SECRET_KEY
 * absent or CAPTCHA_PROVIDER unset). The submit path is then byte-identical to
 * the pre-PB-LR.B state — no CAPTCHA token required, no HTTP call, no change
 * in behavior for existing callers or existing test coverage.
 *
 * INVARIANT: when this verifier is in use, _submitImpl is BYTE-IDENTICAL to
 * the pre-PB-LR.B implementation (the verify() call returns synchronously
 * true with no side effects).
 */
export class NoopCaptchaVerifier implements CaptchaVerifier {
  async verify(_token: string | undefined, _remoteIp?: string): Promise<boolean> {
    return true;
  }
}

// ─── Cloudflare Turnstile adapter ─────────────────────────────────────────────

/**
 * Cloudflare Turnstile siteverify endpoint.
 * See: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * TurnstileCaptchaVerifier — Cloudflare Turnstile provider adapter.
 *
 * Reads CAPTCHA_SECRET_KEY from the injected env (default: process.env).
 * Makes a POST to the Turnstile siteverify endpoint.
 *
 * INERT without valid credentials: the HTTP call is real but returns {success:false}
 * for an invalid token / missing key — which triggers the fail-OPEN catch in the
 * caller (_submitImpl), so no lead is ever lost due to misconfiguration.
 *
 * The constructor accepts an injectable env for testing without real HTTP calls.
 */
export class TurnstileCaptchaVerifier implements CaptchaVerifier {
  private readonly secretKey: string;

  constructor(secretKey: string) {
    this.secretKey = secretKey;
  }

  async verify(token: string | undefined, remoteIp?: string): Promise<boolean> {
    // An absent token is an immediate false (no HTTP call needed — bot behavior).
    if (!token) {
      return false;
    }

    const body = new URLSearchParams({
      secret: this.secretKey,
      response: token,
    });
    if (remoteIp) {
      body.set('remoteip', remoteIp);
    }

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      // HTTP-level error from the provider — throw so the caller can fail-OPEN.
      throw new Error(`Turnstile HTTP error: ${response.status}`);
    }

    const json = (await response.json()) as { success: boolean };
    return json.success === true;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * getCaptchaVerifier — factory that reads process.env and returns the
 * appropriate verifier.
 *
 * Resolution logic:
 *   1. CAPTCHA_SECRET_KEY absent  → NoopCaptchaVerifier (unconfigured default).
 *   2. CAPTCHA_PROVIDER unset     → NoopCaptchaVerifier (explicit: need both).
 *   3. CAPTCHA_PROVIDER=turnstile → TurnstileCaptchaVerifier(secretKey).
 *   4. Unknown provider           → NoopCaptchaVerifier (conservative default;
 *                                   unknown config is treated as unconfigured).
 *
 * Called once per request — NOT cached globally — so env changes in tests take
 * immediate effect (no module-level singleton to reset between tests).
 *
 * INVARIANT: when both env vars are absent (the normal dev/test default),
 * returns a NoopCaptchaVerifier and the submit path is byte-identical to
 * the pre-PB-LR.B behavior.
 */
export function getCaptchaVerifier(): CaptchaVerifier {
  const secretKey = process.env['CAPTCHA_SECRET_KEY'];
  const provider  = process.env['CAPTCHA_PROVIDER'];

  // Unconfigured: missing key or missing provider → Noop (byte-identical path).
  if (!secretKey || !provider) {
    return new NoopCaptchaVerifier();
  }

  if (provider === 'turnstile') {
    return new TurnstileCaptchaVerifier(secretKey);
  }

  // Unknown provider: treat as unconfigured (conservative default).
  return new NoopCaptchaVerifier();
}
