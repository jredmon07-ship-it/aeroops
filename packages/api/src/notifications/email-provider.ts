/**
 * notifications/email-provider.ts — the email provider SEAM (Slice P1.3).
 *
 * Mirrors the house pattern established by booking/captcha.ts: an interface +
 * a stub that is INERT when unconfigured + a real implementation selected by
 * env, behind a single memoized factory.
 *
 * ── PROVIDER SEAM ─────────────────────────────────────────────────────────────
 *   getEmailProvider() reads EMAIL_API_KEY + EMAIL_FROM from env:
 *     - Either unset → StubEmailProvider (default — logs "would send" and
 *       returns a synthetic id; NEVER throws). A missing key means
 *       notifications are silently inert, never a broken request — this
 *       mirrors NoopCaptchaVerifier's "byte-identical when unconfigured"
 *       posture: sendNotification's caller sees the exact same outcome
 *       shape whether or not email is configured.
 *     - Both set    → RealEmailProvider — raw fetch against Resend's API
 *       (https://api.resend.com/emails), Bearer EMAIL_API_KEY. NO npm SDK
 *       (per the no-new-heavy-deps posture).
 *   Memoized per-process (module-level singleton) — the
 *   memoization rationale: these are deployment-level config that does not
 *   change mid-process. __resetEmailProviderForTests clears it for tests.
 *
 * ── API SURFACE (confirmed 2026-07 against resend.com/docs/api-reference) ────
 *   POST https://api.resend.com/emails
 *   Auth: Authorization: Bearer <EMAIL_API_KEY>
 *   Body (JSON): { from, to: [...], subject, html, text }
 *   Success: 200 with { id: string }.
 *
 * ── PRIVACY ────────────────────────────────────────────────────────────────────
 *   This module NEVER logs the rendered email body — only high-level send
 *   attempts (see StubEmailProvider.send). The caller (send-notification.ts)
 *   is responsible for what it persists to notification_log (recipient email
 *   + subject only — see that file).
 */

const RESEND_API_BASE = 'https://api.resend.com';

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * EmailProviderError — thrown by RealEmailProvider on any HTTP-level failure
 * (non-2xx response or malformed response body). Carries NO email body —
 * provider status + a short message only. Callers (send-notification.ts)
 * MUST catch this and record a 'failed' notification_log row — never let it
 * escape as an unhandled rejection.
 */
export class EmailProviderError extends Error {
  readonly code = 'EMAIL_PROVIDER_ERROR' as const;
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'EmailProviderError';
    this.status = status;
  }
}

// ─── Payload / result types ───────────────────────────────────────────────────

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendEmailResult {
  id: string;
}

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * EmailProvider — the abstraction boundary for sending a transactional email.
 *
 * CONTRACT:
 *   - StubEmailProvider.send NEVER throws (unconfigured is a no-op success).
 *   - RealEmailProvider.send THROWS EmailProviderError on any provider-level
 *     failure — callers must catch this and record 'failed', never crash.
 */
export interface EmailProvider {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

// ─── Stub (default — unconfigured) ───────────────────────────────────────────

/**
 * StubEmailProvider — the DEFAULT implementation.
 *
 * Used when EMAIL_API_KEY / EMAIL_FROM are not configured. Logs a single
 * "would send" line (recipient + subject ONLY — never the body) and returns
 * a synthetic id. NEVER throws — a missing key means every notification
 * completes as a normal (unsent) 'sent' log row rather than breaking the
 * caller, exactly like NoopCaptchaVerifier's always-true default.
 */
export class StubEmailProvider implements EmailProvider {
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    // eslint-disable-next-line no-console
    console.log(
      `[email] EMAIL_API_KEY/EMAIL_FROM not configured — would send to="${input.to}" subject="${input.subject}" (no real email sent).`,
    );
    return { id: `stub_${Date.now()}_${Math.random().toString(36).slice(2, 10)}` };
  }
}

// ─── Real implementation (Resend) ────────────────────────────────────────────

export class RealEmailProvider implements EmailProvider {
  private readonly apiKey: string;
  private readonly from: string;

  constructor(apiKey: string, from: string) {
    this.apiKey = apiKey;
    this.from = from;
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const res = await fetch(`${RESEND_API_BASE}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });

    if (!res.ok) {
      throw new EmailProviderError(`Resend send failed (HTTP ${res.status})`, res.status);
    }

    let json: { id?: string };
    try {
      json = (await res.json()) as { id?: string };
    } catch {
      throw new EmailProviderError('Resend send: response was not valid JSON');
    }
    if (!json.id) {
      throw new EmailProviderError('Resend send: response missing id');
    }
    return { id: json.id };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

let _memoizedProvider: EmailProvider | null = null;

/**
 * getEmailProvider — factory that reads process.env and returns the
 * configured EmailProvider.
 *
 * Resolution:
 *   1. EMAIL_API_KEY or EMAIL_FROM absent → StubEmailProvider (NEVER a real
 *      HTTP call anywhere).
 *   2. Both present → RealEmailProvider(apiKey, from).
 */
export function getEmailProvider(): EmailProvider {
  if (_memoizedProvider) return _memoizedProvider;

  const apiKey = process.env['EMAIL_API_KEY'];
  const from = process.env['EMAIL_FROM'];
  if (!apiKey || !from) {
    _memoizedProvider = new StubEmailProvider();
    return _memoizedProvider;
  }

  _memoizedProvider = new RealEmailProvider(apiKey, from);
  return _memoizedProvider;
}

/** Test-only: reset the memoized provider so tests can reconfigure env + re-resolve. */
export function __resetEmailProviderForTests(): void {
  _memoizedProvider = null;
}
