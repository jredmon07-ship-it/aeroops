/**
 * lib/auth-errors.ts — Pure helpers for mapping auth errors to redirect strategies.
 *
 * PURE: no DOM, no Next.js imports, no I/O.
 * This makes the mapping unit-testable without any framework setup.
 *
 * Usage in a server component:
 *
 *   import { mapAuthErrorToResponse } from '@/lib/auth-errors';
 *   import { requireCapability, ForbiddenError, UnauthenticatedError } from '@aeroops/api';
 *   import { redirect } from 'next/navigation';
 *
 *   try {
 *     requireCapability(session, 'org:manage_settings');
 *   } catch (err) {
 *     const action = mapAuthErrorToResponse(err);
 *     if (action === 'forbidden')   redirect(`/o/${slug}/no-access?reason=insufficient_role`);
 *     if (action === 'login')       redirect(`/o/${slug}/login`);
 *     throw err; // 'rethrow' — unexpected error, propagate to Next.js error boundary
 *   }
 */

import { ForbiddenError, UnauthenticatedError } from '@aeroops/api';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * AuthErrorAction — the redirect strategy to apply for a caught error.
 *
 *   'forbidden'   → redirect to no-access (insufficient role)
 *   'login'       → redirect to login (unauthenticated / session expired)
 *   'rethrow'     → not an auth error; re-throw to let Next.js handle it
 */
export type AuthErrorAction = 'forbidden' | 'login' | 'rethrow';

// ─── mapAuthErrorToResponse ───────────────────────────────────────────────────

/**
 * mapAuthErrorToResponse — maps a caught error to a redirect action.
 *
 * PURE: accepts unknown (the catch clause type) and narrows via instanceof.
 * Never throws; never accesses DOM or Next.js APIs.
 *
 * @param err - The error caught in a try/catch around requireCapability.
 * @returns   - 'forbidden' | 'login' | 'rethrow'
 */
export function mapAuthErrorToResponse(err: unknown): AuthErrorAction {
  if (err instanceof ForbiddenError) return 'forbidden';
  if (err instanceof UnauthenticatedError) return 'login';
  return 'rethrow';
}
