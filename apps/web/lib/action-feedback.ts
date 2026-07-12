/**
 * lib/action-feedback.ts — the standard result→feedback mapping for server
 * actions (toast-on-mutation standard, design-system core).
 *
 * Every server action in this app returns either an ok-shaped result or one
 * of the tagged error results from lib/action-errors-result.ts:
 *   { error: 'forbidden' } | { error: 'unauthenticated' }
 *   | { error: 'validation'; message } | { error: 'server' }
 *
 * Pattern for a primary mutation in a client component:
 *
 *   const result = await someMutationAction(...);
 *   if ('error' in result) {
 *     // EITHER keep the existing inline error surface (preferred for
 *     // correctable form input) OR, with no inline surface:
 *     toast.error(actionErrorMessage(result));
 *     return;
 *   }
 *   toast.success('Payment recorded');
 *
 * PURE MODULE: no React, no DOM — unit-testable under vitest's node env.
 */
import { toast } from './toast-store';

export interface ActionErrorLike {
  error: string;
  message?: string;
}

const DEFAULT_FALLBACK = 'Something went wrong. Please try again.';

/** Maps a tagged action error result to user-facing copy. */
export function actionErrorMessage(
  result: ActionErrorLike,
  fallback: string = DEFAULT_FALLBACK,
): string {
  switch (result.error) {
    case 'forbidden':
      return "You don't have permission to do that.";
    case 'unauthenticated':
      return 'Your session has expired. Please sign in again.';
    case 'validation':
      return result.message && result.message.length > 0
        ? result.message
        : fallback;
    default:
      return fallback;
  }
}

/** Convenience: toast.error with the standard mapping applied. */
export function toastActionError(
  result: ActionErrorLike,
  fallback?: string,
): void {
  toast.error(actionErrorMessage(result, fallback));
}
