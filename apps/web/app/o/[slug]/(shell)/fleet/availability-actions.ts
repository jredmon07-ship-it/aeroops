/**
 * fleet/availability-actions.ts — Server actions for resource availability
 * window CRUD (Slice AV1.3).
 *
 * Wraps:
 *   listAvailabilityWindows   (schedule:manage_resources)
 *   createAvailabilityWindow  (schedule:manage_resources)
 *   deleteAvailabilityWindow  (schedule:manage_resources)
 *
 * Pattern mirrors dispatch-gate-actions.ts + fleet/actions.ts:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability inside the fn).
 *   3. Map ForbiddenError / UnauthenticatedError → { error: 'forbidden'|'unauthenticated' }.
 *   4. Map ValidationError (code === 'VALIDATION') → { error: 'validation', message }.
 *   5. Pass through ok:false arms as-is.
 *
 * Dates are serialized to ISO strings at the action boundary.
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 * RLS + org_id scoping are enforced inside the API functions.
 *
 * [VERIFY-AV1-A]: availability windows = OPERATOR operating-hours data ONLY.
 * NOT an FAA duty-time, rest-period, Part-117/135/121, or flight-time-limit
 * determination.
 */
'use server';

import { serializeDate } from '@/lib/serialize-date';

import { actionAuth as auth } from '@/lib/action-auth';
import {
  listAvailabilityWindows,
  createAvailabilityWindow,
  deleteAvailabilityWindow,
} from '@aeroops/api';
import type {
  AvailabilityWindowView,
} from '@aeroops/api';

// ─── Serialized view (Dates → string) ────────────────────────────────────────

export interface SerializedAvailabilityWindowView {
  id: string;
  resourceId: string;
  /** ISO 8601 day-of-week: 1=Monday … 7=Sunday. */
  dayOfWeek: number;
  /** Minutes since midnight (0..1439). */
  startMinute: number;
  /** Minutes since midnight (1..1440). */
  endMinute: number;
  /** IANA timezone string (e.g. "America/New_York"). */
  tz: string;
  createdBy: string;
  createdAt: string;
}

// ─── Error shapes ─────────────────────────────────────────────────────────────

import { mapAuthError, isValidationError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ValidationErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ValidationErrorResult, ServerErrorResult };

function stripPrefix(msg: string): string {
  return msg.replace(/^\[[\w:/-]+\]\s*/, '');
}

// ─── Date serialization ───────────────────────────────────────────────────────
function serializeWindow(w: AvailabilityWindowView): SerializedAvailabilityWindowView {
  return {
    id: w.id,
    resourceId: w.resourceId,
    dayOfWeek: w.dayOfWeek,
    startMinute: w.startMinute,
    endMinute: w.endMinute,
    tz: w.tz,
    createdBy: w.createdBy,
    createdAt: serializeDate(w.createdAt) ?? '',
  };
}

// ─── listAvailabilityWindowsAction ───────────────────────────────────────────

export type ListAvailabilityWindowsActionResult =
  | { ok: true; windows: SerializedAvailabilityWindowView[] }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function listAvailabilityWindowsAction(input: {
  resourceId: string;
}): Promise<ListAvailabilityWindowsActionResult> {
  const session = await auth();
  try {
    const result = await listAvailabilityWindows(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, windows: result.windows.map(serializeWindow) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── createAvailabilityWindowAction ──────────────────────────────────────────

export type CreateAvailabilityWindowActionResult =
  | { ok: true; windows: SerializedAvailabilityWindowView[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'duplicate' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function createAvailabilityWindowAction(input: {
  resourceId: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  tz: string;
}): Promise<CreateAvailabilityWindowActionResult> {
  const session = await auth();
  try {
    const result = await createAvailabilityWindow(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, windows: result.windows.map(serializeWindow) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── deleteAvailabilityWindowAction ──────────────────────────────────────────

export type DeleteAvailabilityWindowActionResult =
  | { ok: true; windows: SerializedAvailabilityWindowView[] }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function deleteAvailabilityWindowAction(input: {
  windowId: string;
}): Promise<DeleteAvailabilityWindowActionResult> {
  const session = await auth();
  try {
    const result = await deleteAvailabilityWindow(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, windows: result.windows.map(serializeWindow) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}
