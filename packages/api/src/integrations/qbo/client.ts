/**
 * integrations/qbo/client.ts — the QuickBooks Online provider seam (Slice QB1).
 *
 * Mirrors the house pattern established by booking/captcha.ts: an interface
 * + a stub that is INERT when unconfigured + a real implementation selected
 * by env, behind a single factory.
 *
 * ── PROVIDER SEAM ─────────────────────────────────────────────────────────────
 *   getQboClient() reads QBO_CLIENT_ID + QBO_CLIENT_SECRET from env:
 *     - Either unset → stubQboClient (default — every call throws
 *       QboNotConfiguredError with a clear message; callers MUST catch this
 *       and return a typed { ok:false, reason:'not_configured' } — never a
 *       crash. See integrations/qbo/export-invoice.ts).
 *     - Both set      → realQboClient (fetch against the QBO v3 REST API).
 *   Memoized per-process (module-level singleton) — QBO_CLIENT_ID/SECRET are
 *   deployment-level config that does not change mid-process.
 *
 * ── API SURFACE ───────────────────────────────────────────────────────────────
 *   QBO v3 Accounting API base URLs (confirmed against Intuit's own
 *   oauth-jsclient SDK source, 2026-07):
 *     sandbox:    https://sandbox-quickbooks.api.intuit.com
 *     production: https://quickbooks.api.intuit.com
 *   OAuth2 endpoints:
 *     authorize: https://appcenter.intuit.com/connect/oauth2
 *     token:     https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
 *   scope: com.intuit.quickbooks.accounting
 *
 * ── MONEY / PCI BOUNDARY ─────────────────────────────────────────────────────
 *   This client NEVER touches card/bank data. It pushes existing operator
 *   invoice RECORDS (Slice B1) as QBO Invoice objects — a bookkeeping
 *   export, not a payment. NO Stripe. NO charge. NO money movement.
 *
 * [VERIFY-QB1-SEC-1]: qbo_connection tokens are plaintext at rest in this
 * slice (migration 0021 comment) — encryption-at-rest is a flagged
 * production follow-up; this client only ever receives a token value that
 * the caller (integrations/qbo/export-invoice.ts / connect.ts) already
 * loaded from the DB — it does not itself read qbo_connection.
 */

// ─── Env-configurable pinned API version ─────────────────────────────────────

/**
 * QBO_MINOR_VERSION — pinned minorversion query param for the Accounting API.
 * Overridable via QBO_MINOR_VERSION for deploy-time bumps without a code
 * change (Intuit periodically advances the supported minorversion range).
 */
const DEFAULT_QBO_MINOR_VERSION = '65';

function getMinorVersion(): string {
  return process.env['QBO_MINOR_VERSION'] || DEFAULT_QBO_MINOR_VERSION;
}

/**
 * Hard ceiling on every QBO HTTP round trip. Without it a hung QBO connection
 * (stall, not error) would pin the caller's DB transaction open and, on the
 * Stripe-webhook auto-sync path, hold the webhook ack past Stripe's delivery
 * timeout. AbortSignal.timeout (Node 20+) rejects the fetch with a TimeoutError,
 * which every QBO caller already converts to a typed provider_error refusal.
 */
const QBO_FETCH_TIMEOUT_MS = 15_000;

// ─── Base URLs ────────────────────────────────────────────────────────────────

const QBO_SANDBOX_API_BASE = 'https://sandbox-quickbooks.api.intuit.com';
const QBO_PRODUCTION_API_BASE = 'https://quickbooks.api.intuit.com';
export const QBO_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const QBO_ACCOUNTING_SCOPE = 'com.intuit.quickbooks.accounting';

function apiBaseForEnv(qboEnv: 'sandbox' | 'production'): string {
  return qboEnv === 'sandbox' ? QBO_SANDBOX_API_BASE : QBO_PRODUCTION_API_BASE;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * QboNotConfiguredError — thrown by every stubQboClient method.
 * Callers MUST catch this and return a typed not_configured refusal —
 * never let it surface as an unhandled 500.
 */
export class QboNotConfiguredError extends Error {
  readonly code = 'QBO_NOT_CONFIGURED' as const;
  constructor(operation: string) {
    super(
      `[QuickBooks] Cannot ${operation}: QBO_CLIENT_ID/QBO_CLIENT_SECRET are not ` +
        'set. Set them in .env (see .env.example) to enable the QuickBooks ' +
        'integration — never hardcode the secret.',
    );
    this.name = 'QboNotConfiguredError';
  }
}

/**
 * QboProviderError — thrown by realQboClient on any HTTP-level failure
 * (non-2xx response, network error, or malformed response body). Carries
 * NO card/bank/PII — provider status + a short message only.
 */
export class QboProviderError extends Error {
  readonly code = 'QBO_PROVIDER_ERROR' as const;
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'QboProviderError';
    this.status = status;
  }
}

// ─── Payload / result types ───────────────────────────────────────────────────

/** A single QBO Invoice Line (SalesItemLineDetail shape). See map-invoice.ts. */
export interface QboInvoiceLine {
  DetailType: 'SalesItemLineDetail';
  Amount: number;
  Description: string;
  SalesItemLineDetail: {
    ItemRef: { value: string; name?: string };
    Qty: number;
    UnitPrice: number;
  };
}

/** The QBO Invoice create request body. See map-invoice.ts (the pure builder). */
export interface QboInvoicePayload {
  Line: QboInvoiceLine[];
  CustomerRef: { value: string; name?: string };
  DocNumber: string;
  PrivateNote: string;
}

export interface QboCreateCustomerInput {
  displayName: string;
  email?: string;
}

/**
 * The QBO Payment (ReceivePayment) create request body. Records that a member
 * paid an already-exported QBO Invoice — a bookkeeping SYNC of an existing
 * AeroOps 'payment' ledger credit, NOT a charge. See sync-payment.ts (the
 * command that builds this from a payment ledger_entry). Amount is a QBO JSON
 * number derived from integer cents via the pure centsToQboAmount helper.
 */
export interface QboPaymentPayload {
  TotalAmt: number;
  CustomerRef: { value: string; name?: string };
  Line: Array<{
    Amount: number;
    LinkedTxn: Array<{ TxnId: string; TxnType: 'Invoice' }>;
  }>;
  PrivateNote: string;
}

/** Per-request connection context — realm + a live (already-refreshed) access token. */
export interface QboRequestContext {
  realmId: string;
  accessToken: string;
}

export interface QboTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Access-token expiry, computed from the provider's expires_in. */
  expiresAt: Date;
}

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * QboClient — the abstraction boundary for the QuickBooks Online API.
 *
 * Implementations:
 *   - stubQboClient  → every method throws QboNotConfiguredError (default
 *     when QBO_CLIENT_ID/QBO_CLIENT_SECRET are unset).
 *   - realQboClient  → fetch against the QBO v3 REST API + the Intuit OAuth2
 *     token endpoint.
 */
export interface QboClient {
  /** POST /v3/company/{realmId}/customer. Returns the new QBO Customer id. */
  createCustomer(
    input: QboCreateCustomerInput,
    ctx: QboRequestContext,
  ): Promise<{ qboCustomerId: string }>;

  /** POST /v3/company/{realmId}/invoice. Returns the new QBO Invoice id. */
  createInvoice(
    payload: QboInvoicePayload,
    ctx: QboRequestContext,
  ): Promise<{ qboInvoiceId: string }>;

  /**
   * POST /v3/company/{realmId}/payment. Records a ReceivePayment against an
   * already-exported QBO Invoice. Returns the new QBO Payment id. This is a
   * bookkeeping SYNC of an existing payment record — it NEVER moves money.
   */
  createPayment(
    payload: QboPaymentPayload,
    ctx: QboRequestContext,
  ): Promise<{ qboPaymentId: string }>;

  /** Exchange an OAuth2 authorization code for an initial token pair. */
  exchangeAuthCode(code: string, redirectUri: string): Promise<QboTokenSet>;

  /** Refresh an expired/expiring access token using the stored refresh token. */
  refreshTokens(refreshToken: string): Promise<QboTokenSet>;
}

// ─── Stub (default — unconfigured) ───────────────────────────────────────────

export class StubQboClient implements QboClient {
  async createCustomer(): Promise<{ qboCustomerId: string }> {
    throw new QboNotConfiguredError('create a QuickBooks customer');
  }
  async createInvoice(): Promise<{ qboInvoiceId: string }> {
    throw new QboNotConfiguredError('create a QuickBooks invoice');
  }
  async createPayment(): Promise<{ qboPaymentId: string }> {
    throw new QboNotConfiguredError('record a QuickBooks payment');
  }
  async exchangeAuthCode(): Promise<QboTokenSet> {
    throw new QboNotConfiguredError('complete the QuickBooks OAuth handshake');
  }
  async refreshTokens(): Promise<QboTokenSet> {
    throw new QboNotConfiguredError('refresh the QuickBooks access token');
  }
}

// ─── Real implementation ─────────────────────────────────────────────────────

export class RealQboClient implements QboClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly apiBase: string;

  constructor(clientId: string, clientSecret: string, qboEnv: 'sandbox' | 'production') {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.apiBase = apiBaseForEnv(qboEnv);
  }

  private authHeader(): string {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`, 'utf-8').toString('base64');
    return `Basic ${basic}`;
  }

  async createCustomer(
    input: QboCreateCustomerInput,
    ctx: QboRequestContext,
  ): Promise<{ qboCustomerId: string }> {
    const body: Record<string, unknown> = { DisplayName: input.displayName };
    if (input.email) {
      body['PrimaryEmailAddr'] = { Address: input.email };
    }

    const res = await fetch(
      `${this.apiBase}/v3/company/${encodeURIComponent(ctx.realmId)}/customer?minorversion=${getMinorVersion()}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(QBO_FETCH_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      throw new QboProviderError(`QuickBooks createCustomer failed (HTTP ${res.status})`, res.status);
    }

    const json = (await res.json()) as { Customer?: { Id?: string } };
    const id = json.Customer?.Id;
    if (!id) {
      throw new QboProviderError('QuickBooks createCustomer: response missing Customer.Id');
    }
    return { qboCustomerId: id };
  }

  async createInvoice(
    payload: QboInvoicePayload,
    ctx: QboRequestContext,
  ): Promise<{ qboInvoiceId: string }> {
    const res = await fetch(
      `${this.apiBase}/v3/company/${encodeURIComponent(ctx.realmId)}/invoice?minorversion=${getMinorVersion()}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(QBO_FETCH_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      throw new QboProviderError(`QuickBooks createInvoice failed (HTTP ${res.status})`, res.status);
    }

    const json = (await res.json()) as { Invoice?: { Id?: string } };
    const id = json.Invoice?.Id;
    if (!id) {
      throw new QboProviderError('QuickBooks createInvoice: response missing Invoice.Id');
    }
    return { qboInvoiceId: id };
  }

  async createPayment(
    payload: QboPaymentPayload,
    ctx: QboRequestContext,
  ): Promise<{ qboPaymentId: string }> {
    const res = await fetch(
      `${this.apiBase}/v3/company/${encodeURIComponent(ctx.realmId)}/payment?minorversion=${getMinorVersion()}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(QBO_FETCH_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      throw new QboProviderError(`QuickBooks createPayment failed (HTTP ${res.status})`, res.status);
    }

    const json = (await res.json()) as { Payment?: { Id?: string } };
    const id = json.Payment?.Id;
    if (!id) {
      throw new QboProviderError('QuickBooks createPayment: response missing Payment.Id');
    }
    return { qboPaymentId: id };
  }

  private async tokenRequest(params: URLSearchParams): Promise<QboTokenSet> {
    const res = await fetch(QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(QBO_FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new QboProviderError(`QuickBooks token request failed (HTTP ${res.status})`, res.status);
    }

    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
      throw new QboProviderError('QuickBooks token response missing required fields');
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    };
  }

  async exchangeAuthCode(code: string, redirectUri: string): Promise<QboTokenSet> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    return this.tokenRequest(params);
  }

  async refreshTokens(refreshToken: string): Promise<QboTokenSet> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    return this.tokenRequest(params);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

let _memoizedClient: QboClient | null = null;

/**
 * getQboClient — factory that reads process.env and returns the configured
 * QboClient. Memoized per-process (deployment config does not change
 * mid-process — unlike the CAPTCHA seam, which re-reads per-request to
 * support tests toggling env vars; QBO tests should inject a fake QboClient
 * directly into the *WithDb command forms instead of relying on env).
 *
 * Resolution:
 *   1. QBO_CLIENT_ID or QBO_CLIENT_SECRET absent → StubQboClient.
 *   2. Both present → RealQboClient (QBO_ENVIRONMENT: 'sandbox' default;
 *      anything else, including 'production', selects the production base URL).
 */
export function getQboClient(): QboClient {
  if (_memoizedClient) return _memoizedClient;

  const clientId = process.env['QBO_CLIENT_ID'];
  const clientSecret = process.env['QBO_CLIENT_SECRET'];

  if (!clientId || !clientSecret) {
    _memoizedClient = new StubQboClient();
    return _memoizedClient;
  }

  const qboEnv = process.env['QBO_ENVIRONMENT'] === 'production' ? 'production' : 'sandbox';
  _memoizedClient = new RealQboClient(clientId, clientSecret, qboEnv);
  return _memoizedClient;
}

/** Test-only: reset the memoized client so tests can reconfigure env + re-resolve. */
export function __resetQboClientForTests(): void {
  _memoizedClient = null;
}
