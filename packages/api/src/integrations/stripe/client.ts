/**
 * integrations/stripe/client.ts — the Stripe provider seam (Slice B3-foundation).
 *
 * Mirrors the house pattern established by booking/captcha.ts and
 * integrations/qbo/client.ts: an interface + a stub that is INERT when
 * unconfigured + a real implementation selected by env, behind a single
 * factory.
 *
 * ── PROVIDER SEAM ─────────────────────────────────────────────────────────────
 *   getStripeClient() reads STRIPE_SECRET_KEY from env:
 *     - Unset → stubStripeClient (default — every call throws
 *       StripeNotConfiguredError; callers MUST catch this and return a typed
 *       { ok:false, reason:'not_configured' } — never a crash).
 *     - Set    → realStripeClient (raw fetch against the Stripe REST API —
 *       NO stripe npm package, per the no-new-heavy-deps posture; the Stripe
 *       REST API is a stable, well-documented form-encoded HTTP API, so a
 *       thin fetch wrapper is sufficient and keeps the Vercel serverless
 *       bundle free of the (large, native-adjacent) official SDK).
 *   Memoized per-process (module-level singleton) — STRIPE_SECRET_KEY is
 *   deployment-level config that does not change mid-process (mirrors QBO's
 *   client memoization rationale exactly).
 *
 * ── API SURFACE ───────────────────────────────────────────────────────────────
 *   Stripe API base (confirmed 2026-07 against docs.stripe.com/api):
 *     https://api.stripe.com
 *   Auth: HTTP Basic with the secret key as username, empty password:
 *     Authorization: Basic base64(sk_test_...:)
 *   Bodies: application/x-www-form-urlencoded (NOT JSON) for writes.
 *
 * ── MONEY / PCI BOUNDARY (SAQ-A) ─────────────────────────────────────────────
 *   This client NEVER touches card/bank data. It only ever sends/receives
 *   Stripe's own ids, amounts (integer cents), and metadata — the actual
 *   card/bank entry happens on Stripe-hosted fields (client-side, outside
 *   this codebase entirely). See docs/specs/slice-b2-b3-payments.md.
 *
 * ── ACH-FIRST ─────────────────────────────────────────────────────────────────
 *   createPaymentIntent defaults payment_method_types to
 *   ['us_bank_account', 'card'] — ACH first (the fee rationale: Stripe
 *   ACH direct debit is ~0.8%, capped at $5/transaction, vs card's ~2.9%+30¢;
 *   for a $300 rental hour this is a material margin difference). Card stays
 *   available as a fallback in the SAME PaymentIntent.
 */

// ─── Base URL ─────────────────────────────────────────────────────────────────

const STRIPE_API_BASE = 'https://api.stripe.com';

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * StripeNotConfiguredError — thrown by every stubStripeClient method.
 * Callers MUST catch this and return a typed not_configured refusal — never
 * let it surface as an unhandled 500.
 */
export class StripeNotConfiguredError extends Error {
  readonly code = 'STRIPE_NOT_CONFIGURED' as const;
  constructor(operation: string) {
    super(
      `[Stripe] Cannot ${operation}: STRIPE_SECRET_KEY is not set. Set it in ` +
        '.env (see .env.example, TEST key first) to enable Stripe payments — ' +
        'never hardcode the secret.',
    );
    this.name = 'StripeNotConfiguredError';
  }
}

/**
 * StripeProviderError — thrown by realStripeClient on any HTTP-level failure
 * (non-2xx response, network error, or malformed response body). Carries NO
 * card/bank/PII — provider status + a short message only.
 */
export class StripeProviderError extends Error {
  readonly code = 'STRIPE_PROVIDER_ERROR' as const;
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'StripeProviderError';
    this.status = status;
  }
}

/**
 * StripeSignatureVerificationError — thrown by constructWebhookEvent when
 * signature verification fails. Carries the typed reason from
 * verifyStripeSignature (never the raw secret or payload).
 */
export class StripeSignatureVerificationError extends Error {
  readonly code = 'STRIPE_SIGNATURE_VERIFICATION_FAILED' as const;
  readonly reason: string;
  constructor(reason: string) {
    super(`[Stripe] Webhook signature verification failed: ${reason}`);
    this.name = 'StripeSignatureVerificationError';
    this.reason = reason;
  }
}

/**
 * StripeCardDeclinedError — thrown by realStripeClient.createPaymentIntent on
 * an off-session decline (HTTP 402 whose body carries a payment_intent —
 * Stripe's shape for "authentication_required"/card-declined on an
 * off_session:true, confirm:true attempt). Carries the PaymentIntent id (when
 * present) so the caller (autopay.ts) can still record a 'failed'
 * payment_intent_record — never a card/bank value.
 */
export class StripeCardDeclinedError extends Error {
  readonly code = 'STRIPE_CARD_DECLINED' as const;
  readonly stripePaymentIntentId: string | undefined;
  readonly status: string | undefined;
  constructor(message: string, stripePaymentIntentId?: string, status?: string) {
    super(message);
    this.name = 'StripeCardDeclinedError';
    this.stripePaymentIntentId = stripePaymentIntentId;
    this.status = status;
  }
}

// ─── Payload / result types ───────────────────────────────────────────────────

export interface StripeCreateCustomerInput {
  email?: string;
  name?: string;
  metadata?: Record<string, string>;
}

export interface StripeCustomerResult {
  stripeCustomerId: string;
}

/** ACH-first — see file header. Defaulted by the caller (create-payment-intent.ts), not this client. */
export type StripePaymentMethodType = 'us_bank_account' | 'card';

export interface StripeCreatePaymentIntentInput {
  amountCents: number;
  currency: string;
  customerId: string;
  paymentMethodTypes: StripePaymentMethodType[];
  metadata?: Record<string, string>;
  /** Additive (P0-REV) — a specific saved PaymentMethod to charge off-session. */
  paymentMethodId?: string;
  /** Additive (P0-REV) — true for an auto-pay charge with no customer present. */
  offSession?: boolean;
  /** Additive (P0-REV) — confirm the PaymentIntent immediately (paired with paymentMethodId). */
  confirm?: boolean;
  /** Additive (P0-REV) — Stripe's setup_future_usage, only 'off_session' used here. */
  setupFutureUsage?: 'off_session';
  /** Additive (P0-REV) — sent as the Idempotency-Key HTTP header (never in the body). */
  idempotencyKey?: string;
}

export interface StripePaymentIntentResult {
  stripePaymentIntentId: string;
  clientSecret: string;
  status: string;
}

export interface StripeRetrievePaymentIntentResult {
  stripePaymentIntentId: string;
  status: string;
  amountCents: number;
}

/** A verified Stripe webhook event — the ONLY shape callers may trust as authentic. */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

// ─── SetupIntent (save a PM for future off-session use) — Slice P0-REV ───────

export interface StripeCreateSetupIntentInput {
  customerId: string;
  paymentMethodTypes: StripePaymentMethodType[];
  /** e.g. { orgId, userId } — used by the setup_intent.succeeded webhook backstop. */
  metadata?: Record<string, string>;
}

export interface StripeSetupIntentResult {
  stripeSetupIntentId: string;
  clientSecret: string;
  status: string;
}

export interface StripeAttachPaymentMethodInput {
  paymentMethodId: string;
  customerId: string;
}

/** Stripe-permitted DISPLAY fields ONLY — never a raw PAN/account number. */
export interface StripePaymentMethodDisplay {
  stripePaymentMethodId: string;
  type: 'card' | 'us_bank_account';
  last4: string | null;
  brand: string | null;
}

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * StripeClient — the abstraction boundary for the Stripe API.
 *
 * Implementations:
 *   - stubStripeClient  → every method throws StripeNotConfiguredError
 *     (default when STRIPE_SECRET_KEY is unset).
 *   - realStripeClient  → fetch against the Stripe REST API.
 */
export interface StripeClient {
  createCustomer(input: StripeCreateCustomerInput): Promise<StripeCustomerResult>;
  createPaymentIntent(input: StripeCreatePaymentIntentInput): Promise<StripePaymentIntentResult>;
  retrievePaymentIntent(paymentIntentId: string): Promise<StripeRetrievePaymentIntentResult>;
  /**
   * constructWebhookEvent — verify the request signature (via
   * verifyStripeSignature) THEN parse the raw body as a StripeWebhookEvent.
   * Throws StripeSignatureVerificationError on ANY verification failure —
   * callers MUST treat an unverified payload as untrusted input and never
   * process it. Throws StripeNotConfiguredError if STRIPE_WEBHOOK_SECRET is
   * unset (a SEPARATE env var from STRIPE_SECRET_KEY — the webhook secret is
   * endpoint-specific, minted when the endpoint is registered in the Stripe
   * dashboard).
   */
  constructWebhookEvent(rawBody: string, signatureHeader: string | null): Promise<StripeWebhookEvent>;
  /** Slice P0-REV — create a SetupIntent to save a PM for future off-session use. */
  createSetupIntent(input: StripeCreateSetupIntentInput): Promise<StripeSetupIntentResult>;
  /** Slice P0-REV — attach an existing PaymentMethod to a Customer. Returns DISPLAY fields only. */
  attachPaymentMethod(input: StripeAttachPaymentMethodInput): Promise<StripePaymentMethodDisplay>;
}

// ─── Stub (default — unconfigured) ───────────────────────────────────────────

export class StubStripeClient implements StripeClient {
  async createCustomer(): Promise<StripeCustomerResult> {
    throw new StripeNotConfiguredError('create a Stripe customer');
  }
  async createPaymentIntent(): Promise<StripePaymentIntentResult> {
    throw new StripeNotConfiguredError('create a Stripe PaymentIntent');
  }
  async retrievePaymentIntent(): Promise<StripeRetrievePaymentIntentResult> {
    throw new StripeNotConfiguredError('retrieve a Stripe PaymentIntent');
  }
  async constructWebhookEvent(): Promise<StripeWebhookEvent> {
    throw new StripeNotConfiguredError('verify a Stripe webhook event');
  }
  async createSetupIntent(): Promise<StripeSetupIntentResult> {
    throw new StripeNotConfiguredError('create a Stripe SetupIntent');
  }
  async attachPaymentMethod(): Promise<StripePaymentMethodDisplay> {
    throw new StripeNotConfiguredError('attach a Stripe PaymentMethod');
  }
}

// ─── Real implementation ─────────────────────────────────────────────────────

export class RealStripeClient implements StripeClient {
  private readonly secretKey: string;
  private readonly webhookSecret: string | undefined;

  constructor(secretKey: string, webhookSecret: string | undefined) {
    this.secretKey = secretKey;
    this.webhookSecret = webhookSecret;
  }

  private authHeader(): string {
    const basic = Buffer.from(`${this.secretKey}:`, 'utf-8').toString('base64');
    return `Basic ${basic}`;
  }

  private async post(path: string, form: URLSearchParams, headers?: Record<string, string>): Promise<unknown> {
    const res = await fetch(`${STRIPE_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...headers,
      },
      body: form.toString(),
    });
    if (!res.ok) {
      // Off-session decline / authentication_required: Stripe returns HTTP 402
      // with a body carrying the (unconfirmed/failed) payment_intent. Surface
      // this distinctly so the caller (autopay.ts) can record a 'failed'
      // payment_intent_record with the PI id, rather than a generic provider
      // error with none.
      if (res.status === 402) {
        let body: { error?: { payment_intent?: { id?: string; status?: string } } } = {};
        try {
          body = (await res.json()) as typeof body;
        } catch {
          // Malformed body — fall through to the generic provider error below.
        }
        const pi = body.error?.payment_intent;
        if (pi) {
          throw new StripeCardDeclinedError(
            `Stripe ${path} declined (HTTP 402)`,
            pi.id,
            pi.status,
          );
        }
      }
      throw new StripeProviderError(`Stripe ${path} failed (HTTP ${res.status})`, res.status);
    }
    return res.json();
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${STRIPE_API_BASE}${path}`, {
      method: 'GET',
      headers: { Authorization: this.authHeader(), Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new StripeProviderError(`Stripe ${path} failed (HTTP ${res.status})`, res.status);
    }
    return res.json();
  }

  async createCustomer(input: StripeCreateCustomerInput): Promise<StripeCustomerResult> {
    const form = new URLSearchParams();
    if (input.email) form.set('email', input.email);
    if (input.name) form.set('name', input.name);
    if (input.metadata) {
      for (const [k, v] of Object.entries(input.metadata)) {
        form.set(`metadata[${k}]`, v);
      }
    }
    const json = (await this.post('/v1/customers', form)) as { id?: string };
    if (!json.id) throw new StripeProviderError('Stripe createCustomer: response missing id');
    return { stripeCustomerId: json.id };
  }

  async createPaymentIntent(input: StripeCreatePaymentIntentInput): Promise<StripePaymentIntentResult> {
    const form = new URLSearchParams();
    form.set('amount', String(input.amountCents));
    form.set('currency', input.currency);
    form.set('customer', input.customerId);
    input.paymentMethodTypes.forEach((type, i) => {
      form.set(`payment_method_types[${i}]`, type);
    });
    if (input.metadata) {
      for (const [k, v] of Object.entries(input.metadata)) {
        form.set(`metadata[${k}]`, v);
      }
    }
    // Additive (P0-REV) — off-session auto-pay fields.
    if (input.paymentMethodId) form.set('payment_method', input.paymentMethodId);
    if (input.offSession) form.set('off_session', 'true');
    if (input.confirm) form.set('confirm', 'true');
    if (input.setupFutureUsage) form.set('setup_future_usage', input.setupFutureUsage);

    const headers = input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : undefined;
    const json = (await this.post('/v1/payment_intents', form, headers)) as {
      id?: string;
      client_secret?: string;
      status?: string;
    };
    if (!json.id || !json.client_secret || !json.status) {
      throw new StripeProviderError('Stripe createPaymentIntent: response missing required fields');
    }
    return { stripePaymentIntentId: json.id, clientSecret: json.client_secret, status: json.status };
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<StripeRetrievePaymentIntentResult> {
    const json = (await this.get(`/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`)) as {
      id?: string;
      status?: string;
      amount?: number;
    };
    if (!json.id || !json.status || typeof json.amount !== 'number') {
      throw new StripeProviderError('Stripe retrievePaymentIntent: response missing required fields');
    }
    return { stripePaymentIntentId: json.id, status: json.status, amountCents: json.amount };
  }

  async constructWebhookEvent(rawBody: string, signatureHeader: string | null): Promise<StripeWebhookEvent> {
    if (!this.webhookSecret) {
      throw new StripeNotConfiguredError('verify a Stripe webhook event (STRIPE_WEBHOOK_SECRET unset)');
    }
    // Lazy import to keep this module's static graph free of a hard
    // dependency cycle risk — webhook-verify.ts has none, but this keeps the
    // signature-check as an explicit, separately-testable seam.
    const { verifyStripeSignature } = await import('./webhook-verify.js');
    const verifyResult = verifyStripeSignature(rawBody, signatureHeader, this.webhookSecret);
    if (!verifyResult.ok) {
      throw new StripeSignatureVerificationError(verifyResult.reason);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new StripeProviderError('Stripe webhook payload is not valid JSON');
    }
    const event = parsed as { id?: string; type?: string; data?: { object?: unknown } };
    if (!event.id || !event.type || !event.data?.object) {
      throw new StripeProviderError('Stripe webhook payload missing required fields (id/type/data.object)');
    }
    return {
      id: event.id,
      type: event.type,
      data: { object: event.data.object as Record<string, unknown> },
    };
  }

  async createSetupIntent(input: StripeCreateSetupIntentInput): Promise<StripeSetupIntentResult> {
    const form = new URLSearchParams();
    form.set('customer', input.customerId);
    input.paymentMethodTypes.forEach((type, i) => {
      form.set(`payment_method_types[${i}]`, type);
    });
    if (input.metadata) {
      for (const [k, v] of Object.entries(input.metadata)) {
        form.set(`metadata[${k}]`, v);
      }
    }
    const json = (await this.post('/v1/setup_intents', form)) as {
      id?: string;
      client_secret?: string;
      status?: string;
    };
    if (!json.id || !json.client_secret || !json.status) {
      throw new StripeProviderError('Stripe createSetupIntent: response missing required fields');
    }
    return { stripeSetupIntentId: json.id, clientSecret: json.client_secret, status: json.status };
  }

  async attachPaymentMethod(input: StripeAttachPaymentMethodInput): Promise<StripePaymentMethodDisplay> {
    const form = new URLSearchParams();
    form.set('customer', input.customerId);
    const json = (await this.post(
      `/v1/payment_methods/${encodeURIComponent(input.paymentMethodId)}/attach`,
      form,
    )) as {
      id?: string;
      type?: string;
      card?: { last4?: string; brand?: string };
      us_bank_account?: { last4?: string; bank_name?: string };
    };
    if (!json.id || !json.type) {
      throw new StripeProviderError('Stripe attachPaymentMethod: response missing required fields');
    }
    const type = json.type === 'us_bank_account' ? 'us_bank_account' : 'card';
    const last4 = type === 'card' ? (json.card?.last4 ?? null) : (json.us_bank_account?.last4 ?? null);
    const brand = type === 'card' ? (json.card?.brand ?? null) : (json.us_bank_account?.bank_name ?? null);
    return { stripePaymentMethodId: json.id, type, last4, brand };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

let _memoizedClient: StripeClient | null = null;

/**
 * getStripeClient — factory that reads process.env and returns the
 * configured StripeClient.
 *
 * Resolution:
 *   1. STRIPE_SECRET_KEY absent → StubStripeClient (every call throws
 *      StripeNotConfiguredError; NO real Stripe call anywhere).
 *   2. Present → RealStripeClient(secretKey, webhookSecret). webhookSecret
 *      (STRIPE_WEBHOOK_SECRET) may be independently unset — in that case
 *      constructWebhookEvent alone still throws StripeNotConfiguredError,
 *      while createCustomer/createPaymentIntent/retrievePaymentIntent work
 *      normally (the two secrets activate independently, matching how a
 *      founder would configure TEST keys before registering the webhook
 *      endpoint in the Stripe dashboard).
 */
export function getStripeClient(): StripeClient {
  if (_memoizedClient) return _memoizedClient;

  const secretKey = process.env['STRIPE_SECRET_KEY'];
  if (!secretKey) {
    _memoizedClient = new StubStripeClient();
    return _memoizedClient;
  }

  const webhookSecret = process.env['STRIPE_WEBHOOK_SECRET'];
  _memoizedClient = new RealStripeClient(secretKey, webhookSecret);
  return _memoizedClient;
}

/** Test-only: reset the memoized client so tests can reconfigure env + re-resolve. */
export function __resetStripeClientForTests(): void {
  _memoizedClient = null;
}
