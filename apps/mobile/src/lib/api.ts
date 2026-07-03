/**
 * lib/api.ts — Typed API client for the AeroOps mobile app.
 *
 * SECURITY INVARIANTS (ADR-0010 + Slice 4M-REVOKE, [VERIFY-4M-SEC-1]):
 *   - The Bearer token is sourced from AuthContext/expo-secure-store only
 *     (never constructed client-side).
 *   - org_id is NEVER sent in request body or headers — it lives in the signed token.
 *   - AUTH_SECRET is NEVER in the bundle; only opaque tokens are stored.
 *   - On a 401 from any authenticated read: this client calls POST
 *     /auth/refresh EXACTLY ONCE (single-flight — concurrent 401s share one
 *     in-flight refresh, never a stampede of refresh calls), retries the
 *     ORIGINAL request once with the fresh access token on success, and
 *     throws AuthError (the caller's existing catch already calls signOut())
 *     if the refresh itself fails OR the retry still 401s.
 *   - The refresh token is rotated on every use — the OLD one presented to
 *     /auth/refresh is dead the instant a new pair is returned.
 *
 * API origin:
 *   Set EXPO_PUBLIC_API_BASE_URL in .env.local (e.g. https://aeroops.example.com).
 *   [VERIFY-4M-DEPLOY-1]: needs a deployed backend; see README.
 *   Falls back to localhost:3000 for local dev (useful for emulators via 10.0.2.2
 *   on Android — the caller is responsible for the correct host per platform).
 */

import type {
  MobileReservationDTO,
  MobileResourceDTO,
  MobileScheduleResponse,
  MobileFleetListResponse,
  MobileFleetDetailResponse,
  MobileAircraftDetailDTO,
  MobileSquawksResponse,
  MobileAlertsResponse,
} from '@aeroops/core';
import { getAccessToken, getRefreshToken, saveTokens, clearTokens } from './token-store';

// ─── Base URL ─────────────────────────────────────────────────────────────────

/**
 * API base URL from the Expo public env variable.
 *
 * EXPO_PUBLIC_* variables are inlined at bundle time by Expo's Metro transform.
 * They are safe to reference in RN code but MUST NOT contain secrets.
 * The API token (secret) goes in expo-secure-store, not here.
 *
 * Default to localhost:3000 for local simulator dev only.
 */
const API_BASE_URL: string =
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- env may be ''
  (process.env['EXPO_PUBLIC_API_BASE_URL'] || 'http://localhost:3000').replace(/\/$/, '');

// ─── Error types ──────────────────────────────────────────────────────────────

/** Thrown when the server returns 401 — caller must clear token + route to login. */
export class AuthError extends Error {
  constructor(message = 'unauthenticated') {
    super(message);
    this.name = 'AuthError';
  }
}

/** Thrown when the server returns 403. */
export class ForbiddenError extends Error {
  constructor(message = 'forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Thrown for 4xx errors that are not auth-related. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown when the device is offline or the fetch itself fails. */
export class NetworkError extends Error {
  constructor(message = 'Network request failed') {
    super(message);
    this.name = 'NetworkError';
  }
}

// ─── Login types (mirrors the route response shape) ───────────────────────────

export interface LoginRequest {
  slug: string;
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  accessExpiresAt: string;   // ISO-8601
  refreshToken: string;
  refreshExpiresAt: string;  // ISO-8601
  org: { slug: string; name: string };
  user: { email: string; role: string };
}

interface RefreshResponse {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

// ─── Auth-token update listener ────────────────────────────────────────────────
//
// AuthContext registers a listener so that a SILENT background refresh
// (triggered by apiFetch below) keeps the in-memory context's access token in
// sync with expo-secure-store — otherwise the next screen's call would present
// a stale access token and pay for an extra 401→refresh round trip every time.
// Called with the new access token on a successful refresh, or null when the
// session is torn down (refresh failed / logout).

type AuthTokenListener = (accessToken: string | null) => void;
let authTokenListener: AuthTokenListener | null = null;

export function setAuthTokenListener(listener: AuthTokenListener | null): void {
  authTokenListener = listener;
}

// ─── Low-level fetch helper (NO auth-retry logic — used by login/refresh/logout) ─

async function rawFetch(path: string, options: RequestInit): Promise<Response> {
  const headers = new Headers(options.headers ?? {});
  headers.set('Content-Type', 'application/json');

  try {
    return await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  } catch (cause) {
    // fetch() itself threw — network unavailable or DNS failure.
    throw new NetworkError(cause instanceof Error ? cause.message : 'Network request failed');
  }
}

// ─── Single-flight refresh ──────────────────────────────────────────────────────
//
// Ensures that if multiple in-flight reads all 401 around the same moment,
// only ONE POST /auth/refresh is made — every caller awaits the SAME promise.
// A refresh token can only be used once (rotation), so a stampede of parallel
// refresh calls would only let the first succeed and the rest fail — this
// dedupes that race entirely.

let refreshInFlight: Promise<boolean> | null = null;

async function performRefresh(): Promise<boolean> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    authTokenListener?.(null);
    return false;
  }

  let response: Response;
  try {
    response = await rawFetch('/api/mobile/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // Network failure during refresh — do NOT clear tokens (the device may
    // simply be offline momentarily); the caller surfaces this as a failed
    // retry, and the next foreground attempt will try again.
    return false;
  }

  if (!response.ok) {
    // Refresh token invalid/expired/revoked/reused — the session is dead.
    await clearTokens();
    authTokenListener?.(null);
    return false;
  }

  const data = (await response.json()) as RefreshResponse;
  await saveTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
  authTokenListener?.(data.accessToken);
  return true;
}

function ensureFreshToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// ─── Authenticated fetch helper (with single-retry-on-401) ─────────────────────

async function apiFetch(
  path: string,
  options: RequestInit & { token?: string | null },
  isRetry = false,
): Promise<Response> {
  const { token, ...fetchOptions } = options;

  const accessToken = token ?? (await getAccessToken());
  const headers = new Headers(fetchOptions.headers ?? {});
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  const response = await rawFetch(path, { ...fetchOptions, headers });

  if (response.status === 401 && !isRetry) {
    const refreshed = await ensureFreshToken();
    if (refreshed) {
      const freshToken = await getAccessToken();
      return apiFetch(path, { ...options, token: freshToken }, true);
    }
  }

  if (response.status === 401) {
    throw new AuthError();
  }
  if (response.status === 403) {
    throw new ForbiddenError();
  }

  return response;
}

// ─── Auth API ─────────────────────────────────────────────────────────────────

/**
 * login — POST /api/mobile/v1/auth/login
 *
 * Sends slug + email + password (all required; no org_id).
 * Returns a short-lived access token + a revocable refresh token on success.
 *
 * Uses rawFetch (NOT apiFetch): a 401 here means "invalid credentials", not
 * "expired token" — it must NEVER trigger the refresh-retry machinery.
 *
 * Failure path:
 *   - 401 → throws AuthError (generic; do NOT distinguish which field failed —
 *            anti-enumeration mirrors the server's byte-identical 401 response).
 *   - Network failure → throws NetworkError.
 */
export async function login(req: LoginRequest): Promise<LoginResponse> {
  const response = await rawFetch('/api/mobile/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify(req),
  });

  if (response.status === 401) {
    throw new AuthError();
  }
  if (!response.ok) {
    throw new ApiError(response.status, `Login failed (${response.status.toString()})`);
  }

  const data: unknown = await response.json();
  // Narrow to LoginResponse (trusts the server contract; typed via interface).
  return data as LoginResponse;
}

/**
 * refreshSession — POST /api/mobile/v1/auth/refresh
 *
 * Low-level, single-shot call (NOT the single-flight-guarded path apiFetch
 * uses internally). Exposed for completeness / explicit callers; AuthContext
 * does not need to call this directly (apiFetch handles it transparently).
 *
 * Returns null on any failure (unknown/expired/revoked/reused token) —
 * mirrors the server's anti-enumeration contract.
 */
export async function refreshSession(refreshToken: string): Promise<RefreshResponse | null> {
  const response = await rawFetch('/api/mobile/v1/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken }),
  });

  if (!response.ok) return null;
  return (await response.json()) as RefreshResponse;
}

/**
 * logout — POST /api/mobile/v1/auth/logout
 *
 * Best-effort + idempotent: ALWAYS resolves (never throws to the caller,
 * even on a network failure) — the caller (AuthContext.signOut) clears local
 * tokens regardless of whether the server-side revoke succeeded.
 */
export async function logout(refreshToken: string): Promise<void> {
  try {
    await rawFetch('/api/mobile/v1/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // Best-effort — offline sign-out still clears local tokens.
  }
}

// ─── Schedule API ─────────────────────────────────────────────────────────────

export interface ScheduleFetchResult {
  reservations: MobileReservationDTO[];
  resources: MobileResourceDTO[];
  from: string;
  to: string;
}

/**
 * fetchSchedule — GET /api/mobile/v1/schedule?from=ISO&to=ISO
 *
 * Requires a valid Bearer token (from expo-secure-store via AuthContext).
 *
 * The window defaults to today UTC if not provided.
 *
 * Failure paths:
 *   - 401 → throws AuthError (caller clears token, redirects to login).
 *   - 403 → throws ForbiddenError.
 *   - Network failure → throws NetworkError.
 *   - 400 (invalid_window) → throws ApiError.
 */
export async function fetchSchedule(
  token: string,
  from: string,
  to: string,
): Promise<ScheduleFetchResult> {
  const params = new URLSearchParams({ from, to });
  const response = await apiFetch(
    `/api/mobile/v1/schedule?${params.toString()}`,
    { method: 'GET', token },
  );

  if (!response.ok) {
    throw new ApiError(response.status, `Schedule fetch failed (${response.status.toString()})`);
  }

  const data = (await response.json()) as MobileScheduleResponse;
  return {
    reservations: data.reservations,
    resources: data.resources,
    from: data.from,
    to: data.to,
  };
}

// ─── Window helpers ───────────────────────────────────────────────────────────

/**
 * todayWindow — returns ISO from/to for a UTC day window starting from now.
 *
 * Used as the default window on the schedule screen.
 * Always returns a window strictly ≤31 days (1 day by default).
 */
export function todayWindow(): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

/**
 * weekWindow — returns ISO from/to for a 7-day window starting from today UTC.
 */
export function weekWindow(): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { from: start.toISOString(), to: end.toISOString() };
}

// ─── Fleet API ────────────────────────────────────────────────────────────────

/**
 * fetchFleet — GET /api/mobile/v1/fleet
 *
 * READ-ONLY. Requires a valid Bearer token. The role must hold fleet:access
 * server-side (enforced inside listAircraft) — a role without it surfaces as
 * ForbiddenError here.
 *
 * Failure paths:
 *   - 401 → throws AuthError (caller clears token, redirects to login).
 *   - 403 → throws ForbiddenError.
 *   - Network failure → throws NetworkError.
 */
export async function fetchFleet(token: string): Promise<MobileFleetListResponse> {
  const response = await apiFetch('/api/mobile/v1/fleet', { method: 'GET', token });

  if (!response.ok) {
    throw new ApiError(response.status, `Fleet fetch failed (${response.status.toString()})`);
  }

  return (await response.json()) as MobileFleetListResponse;
}

/**
 * fetchAircraftDetail — GET /api/mobile/v1/fleet/[id]
 *
 * READ-ONLY. Returns null when the server responds ok:false 'not_found'
 * (unknown id or cross-org — RLS-collapsed, never distinguished).
 *
 * Failure paths:
 *   - 401 → throws AuthError.
 *   - 403 → throws ForbiddenError.
 *   - 404 (not_found) → resolves to null (caller renders an empty state).
 *   - Network failure → throws NetworkError.
 */
export async function fetchAircraftDetail(
  token: string,
  id: string,
): Promise<MobileAircraftDetailDTO | null> {
  const response = await apiFetch(`/api/mobile/v1/fleet/${encodeURIComponent(id)}`, {
    method: 'GET',
    token,
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new ApiError(response.status, `Aircraft detail fetch failed (${response.status.toString()})`);
  }

  const data = (await response.json()) as MobileFleetDetailResponse;
  return data.ok ? data.aircraft : null;
}

// ─── Squawks API ──────────────────────────────────────────────────────────────

/**
 * fetchSquawks — GET /api/mobile/v1/squawks
 *
 * READ-ONLY. Returns the org's OPEN squawks (newest-first, tail-numbered).
 * The role must hold maintenance:access server-side (enforced inside
 * listSquawks) — a role without it surfaces as ForbiddenError here.
 */
export async function fetchSquawks(token: string): Promise<MobileSquawksResponse> {
  const response = await apiFetch('/api/mobile/v1/squawks', { method: 'GET', token });

  if (!response.ok) {
    throw new ApiError(response.status, `Squawks fetch failed (${response.status.toString()})`);
  }

  return (await response.json()) as MobileSquawksResponse;
}

// ─── Alerts API ───────────────────────────────────────────────────────────────

/**
 * fetchAlerts — GET /api/mobile/v1/alerts
 *
 * READ-ONLY. Self-scoped server-side to the caller's own userId — there is
 * no per-user id in this request. Held by ALL roles (app:access).
 */
export async function fetchAlerts(token: string): Promise<MobileAlertsResponse> {
  const response = await apiFetch('/api/mobile/v1/alerts', { method: 'GET', token });

  if (!response.ok) {
    throw new ApiError(response.status, `Alerts fetch failed (${response.status.toString()})`);
  }

  return (await response.json()) as MobileAlertsResponse;
}
