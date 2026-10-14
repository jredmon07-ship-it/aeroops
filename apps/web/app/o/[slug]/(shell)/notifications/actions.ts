/**
 * notifications/actions.ts — Server actions for the self-service email
 * notification preferences page (Slice P1.3).
 *
 * Pattern mirrors portal/actions.ts:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability('app:access') inside — every
 *      role holds it; notification prefs are personal, not role-scoped).
 *   3. Map ForbiddenError / UnauthenticatedError → tagged error result.
 *
 * SELF-SCOPING: neither action accepts a userId — the subject is ALWAYS
 * session.userId, enforced inside @aeroops/api's getMyNotificationPrefs /
 * setMyNotificationPref.
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 */
'use server';

import { actionAuth as auth } from '@/lib/action-auth';
import {
  getMyNotificationPrefs,
  setMyNotificationPref,
} from '@aeroops/api';
import type { NotificationPrefView, NotificationEventType } from '@aeroops/api';

// ─── Error shapes ─────────────────────────────────────────────────────────────

import { mapAuthError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ServerErrorResult };

// ─── getMyNotificationPrefsAction ─────────────────────────────────────────────

export type GetMyNotificationPrefsActionResult =
  | { ok: true; prefs: NotificationPrefView[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function getMyNotificationPrefsAction(): Promise<GetMyNotificationPrefsActionResult> {
  const session = await auth();
  try {
    const prefs = await getMyNotificationPrefs(session);
    return { ok: true, prefs };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── setMyNotificationPrefAction ──────────────────────────────────────────────

export type SetMyNotificationPrefActionResult =
  | { ok: true; pref: NotificationPrefView }
  | AuthErrorResult
  | ServerErrorResult;

export async function setMyNotificationPrefAction(
  eventType: NotificationEventType,
  emailEnabled: boolean,
): Promise<SetMyNotificationPrefActionResult> {
  const session = await auth();
  try {
    const result = await setMyNotificationPref(session, { eventType, emailEnabled });
    return { ok: true, pref: result.pref };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}
