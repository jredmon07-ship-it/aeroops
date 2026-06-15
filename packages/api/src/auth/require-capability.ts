/**
 * require-capability.ts — Enforcement seam for capability-based RBAC.
 *
 * Provides two functions:
 *
 *   requireCapability(session, capability)
 *     → the GATE: called on every mutation / protected data fetch.
 *       Throws ForbiddenError if the role lacks the capability,
 *       throws UnauthenticatedError if the session is missing/incomplete.
 *       Returns the narrowed AppSession on success so callers can chain it.
 *
 *   hasCapability(session, capability)
 *     → UX/nav predicate only; never throws; never the real gate.
 *       Use in React Server Components to conditionally render nav items.
 *       Document at every call site: "UI only — gate enforced by requireCapability".
 *
 * FRAMEWORK-AGNOSTIC: NO next/* import here.
 *
 * AUTHZ CONTRACT:
 *   - Fail-closed: any missing session field → UnauthenticatedError (not ForbiddenError).
 *   - `can()` is the sole dispatch mechanism — no raw `role === 'x'` guards.
 *
 * ROLE STALENESS NOTE (Slice 0.3):
 *   session.role is authoritative for the lifetime of the JWT (default 8 h).
 *   A role change (e.g. demotion from manager to renter) takes effect on the
 *   user's NEXT token refresh / re-login — not immediately. RLS (org_id scoping
 *   via withOrgContext) means a stale role can at worst over-grant WITHIN the
 *   user's own org; it can NEVER cause a cross-org data leak because the RLS
 *   policy gates on org_id, which is also immutable per-session. Instant role
 *   revocation (session-revocation list / short-lived tokens) is a deferred
 *   Slice 0.4+ item and must be implemented before any high-privilege demotion
 *   feature is shipped.
 */

import { can } from '@aeroops/core';
import type { Capability } from '@aeroops/core';
import { UnauthenticatedError } from './session.js';
import type { AppSession } from './types.js';

// ─── ForbiddenError ───────────────────────────────────────────────────────────

/**
 * ForbiddenError — thrown by requireCapability when the caller's role lacks
 * the required capability.
 *
 * Mirrors the shape of UnauthenticatedError (named class with a readonly `code`
 * field) so callers can do:
 *
 *   import { ForbiddenError, UnauthenticatedError } from '@aeroops/api';
 *
 *   try {
 *     const session = requireCapability(rawSession, 'org:manage_settings');
 *   } catch (e) {
 *     if (e instanceof ForbiddenError) return NextResponse.json({}, { status: 403 });
 *     if (e instanceof UnauthenticatedError) return NextResponse.json({}, { status: 401 });
 *     throw e;
 *   }
 */
export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN' as const;
  readonly capability: Capability;

  constructor(capability: Capability, role: string) {
    super(
      `[requireCapability] Role '${role}' does not have capability '${capability}'.`,
    );
    this.name = 'ForbiddenError';
    this.capability = capability;
  }
}

// ─── requireCapability ────────────────────────────────────────────────────────

/**
 * requireCapability — the server-side authz gate.
 *
 * Call this at the top of every mutation and every protected data fetch.
 * It is the canonical replacement for raw `role === 'x'` guards.
 *
 * @param session    - AppSession from auth(); may be null/undefined.
 * @param capability - The capability required to proceed.
 * @returns          - The narrowed AppSession (non-null) on success.
 * @throws UnauthenticatedError if session is null, undefined, or missing
 *                              userId / orgId / role.
 * @throws ForbiddenError if the session.role lacks the capability.
 */
export function requireCapability(
  session: AppSession | null | undefined,
  capability: Capability,
): AppSession {
  // Guard: incomplete/missing session → UNAUTHENTICATED (not FORBIDDEN).
  if (!session || !session.userId || !session.orgId || !session.role) {
    throw new UnauthenticatedError(
      '[requireCapability] No authenticated session. ' +
        'Ensure the caller has checked auth() before calling this function.',
    );
  }

  // Guard: role lacks capability → FORBIDDEN.
  if (!can(session.role, capability)) {
    throw new ForbiddenError(capability, session.role);
  }

  return session;
}

// ─── hasCapability ────────────────────────────────────────────────────────────

/**
 * hasCapability — UX/nav predicate.
 *
 * Returns true/false WITHOUT throwing. Intended for conditional rendering in
 * React Server Components (e.g. hiding menu items for roles that lack a
 * capability). It is NEVER the security gate.
 *
 * Contract: null/undefined/incomplete session → false (fail-closed for UI too).
 *
 * IMPORTANT: Always pair with a requireCapability call in the actual handler.
 * Hiding a UI element is cosmetic; the real gate is requireCapability.
 *
 * @param session    - AppSession from auth(); may be null/undefined.
 * @param capability - The capability to check.
 * @returns boolean  - true if the session role has the capability, false otherwise.
 */
export function hasCapability(
  session: AppSession | null | undefined,
  capability: Capability,
): boolean {
  if (!session || !session.role) return false;
  return can(session.role, capability);
}
