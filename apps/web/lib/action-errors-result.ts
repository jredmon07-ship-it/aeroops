/**
 * lib/action-errors-result.ts — Shared error→result mapping for server actions.
 *
 * Every server action under app/o/[slug]/(shell)/** follows the same catch
 * contract:
 *
 *   ForbiddenError         → { error: 'forbidden' }
 *   UnauthenticatedError   → { error: 'unauthenticated' }
 *   err.code==='VALIDATION'→ { error: 'validation', message }
 *   anything else          → caller returns { error: 'server' }
 *
 * This module is the single home for that mapping (previously duplicated in
 * ~22 actions files). PURE: no DOM, no Next.js imports, no I/O — and NOT a
 * 'use server' module, so it may export sync helpers and types freely.
 *
 * Usage in an action:
 *
 *   } catch (err) {
 *     const mapped = mapActionError(err);
 *     if (mapped) return mapped;
 *     return { error: 'server' };
 *   }
 *
 * Actions that post-process the validation message (e.g. stripPrefix) keep
 * using mapAuthError + isValidationError directly.
 */
import { ForbiddenError, UnauthenticatedError } from '@aeroops/api';

// ─── Result types ─────────────────────────────────────────────────────────────

export type AuthErrorResult =
  | { error: 'forbidden' }
  | { error: 'unauthenticated' };

export type ValidationErrorResult = { error: 'validation'; message: string };

export type ServerErrorResult = { error: 'server'; message?: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Maps ForbiddenError / UnauthenticatedError to a typed result; null otherwise. */
export function mapAuthError(err: unknown): AuthErrorResult | null {
  if (err instanceof ForbiddenError) return { error: 'forbidden' };
  if (err instanceof UnauthenticatedError) return { error: 'unauthenticated' };
  return null;
}

// ValidationError is not exported from @aeroops/api, so detect by .code property.
export function isValidationError(err: unknown): err is { message: string; code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'VALIDATION'
  );
}

/**
 * mapActionError — the full auth+validation mapping in one call.
 * Returns null when the error is neither (caller returns { error: 'server' }).
 */
export function mapActionError(
  err: unknown,
): AuthErrorResult | ValidationErrorResult | null {
  const authErr = mapAuthError(err);
  if (authErr) return authErr;
  if (isValidationError(err)) return { error: 'validation', message: err.message };
  return null;
}
