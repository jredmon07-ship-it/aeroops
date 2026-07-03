/**
 * lib/api.ts — Typed API client for the AeroOps mobile app.
 *
 * SECURITY INVARIANTS (ADR-0010):
 *   - The Bearer token is sourced from AuthContext only (never constructed client-side).
 *   - org_id is NEVER sent in request body or headers — it lives in the signed token.
 *   - AUTH_SECRET is NEVER in the bundle; only the signed opaque token is stored.
 *   - A 401 response → the calling context must clear the token and route to login.
 *     This client signals 401s via the AuthError type so callers handle them cleanly.
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
  token: string;
  expiresAt: string;   // ISO-8601
  org: { slug: string; name: string };
  user: { email: string; role: string };
}

// ─── Low-level fetch helper ───────────────────────────────────────────────────

async function apiFetch(
  path: string,
  options: RequestInit & { token?: string | null },
): Promise<Response> {
  const { token, ...fetchOptions } = options;

  const headers = new Headers(fetchOptions.headers ?? {});
  headers.set('Content-Type', 'application/json');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...fetchOptions,
      headers,
    });
  } catch (cause) {
    // fetch() itself threw — network unavailable or DNS failure.
    throw new NetworkError(cause instanceof Error ? cause.message : 'Network request failed');
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
 * Returns a signed JWT token on success.
 *
 * Failure path:
 *   - 401 → throws AuthError (generic; do NOT distinguish which field failed —
 *            anti-enumeration mirrors the server's byte-identical 401 response).
 *   - Network failure → throws NetworkError.
 */
export async function login(req: LoginRequest): Promise<LoginResponse> {
  const response = await apiFetch('/api/mobile/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify(req),
    // No token on the login request (unauthenticated endpoint).
  });

  if (!response.ok) {
    // apiFetch already throws on 401/403; this catches other 4xx/5xx.
    throw new ApiError(response.status, `Login failed (${response.status.toString()})`);
  }

  const data: unknown = await response.json();
  // Narrow to LoginResponse (trusts the server contract; typed via interface).
  return data as LoginResponse;
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
