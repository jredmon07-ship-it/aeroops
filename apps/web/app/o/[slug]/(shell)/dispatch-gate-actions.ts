/**
 * dispatch-gate-actions.ts — Server actions for Slice 3c dispatch gate.
 *
 * Wraps:
 *   getResourceRequiredTags  (dispatch:access)
 *   addResourceRequiredTag   (dispatch:manage_requirements)
 *   removeResourceRequiredTag (dispatch:manage_requirements)
 *   getDispatchConfig        (dispatch:access)
 *   updateDispatchConfig     (dispatch:manage_requirements)
 *
 * Pattern mirrors fleet/actions.ts + maintenance/actions.ts:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability inside the fn).
 *   3. Map ForbiddenError / UnauthenticatedError → { error: 'forbidden'|'unauthenticated' }.
 *   4. Map ValidationError (code === 'VALIDATION') → { error: 'validation', message }.
 *   5. Pass through ok:false arms as-is (operational refusals are values, not errors).
 *
 * Dates are serialized to ISO strings at the action boundary so RSC → client
 * components receive plain JSON (Dates are NOT JSON-serializable).
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 * RLS + org_id scoping are enforced inside the API functions.
 *
 * [VERIFY-3c-A] requiredTag is FREE-TEXT only; no FAA/currency/medical meaning.
 * [VERIFY-3c-MONEY] balance is a stub; no dollar/Stripe/payment concept.
 */
'use server';

import { auth } from '@/auth';
import {
  getResourceRequiredTags,
  addResourceRequiredTag,
  removeResourceRequiredTag,
  getDispatchConfig,
  updateDispatchConfig,
  ForbiddenError,
  UnauthenticatedError,
} from '@aeroops/api';
import type {
  RequiredTagView,
  DispatchConfigView,
  UpdateDispatchConfigInput,
} from '@aeroops/api';

// ─── Serialized RequiredTagView (Dates → string) ──────────────────────────────

export interface SerializedRequiredTagView {
  id: string;
  /** [VERIFY-3c-A] FREE-TEXT operator label only. No FAA/currency/medical meaning. */
  requiredTag: string;
  createdBy: string;
  createdAt: string;
}

// ─── Error shapes ─────────────────────────────────────────────────────────────

export type AuthErrorResult =
  | { error: 'forbidden' }
  | { error: 'unauthenticated' };

export type ValidationErrorResult = {
  error: 'validation';
  message: string;
};

export type ServerErrorResult = { error: 'server'; message?: string };

function mapAuthError(err: unknown): AuthErrorResult | null {
  if (err instanceof ForbiddenError) return { error: 'forbidden' };
  if (err instanceof UnauthenticatedError) return { error: 'unauthenticated' };
  return null;
}

function isValidationError(err: unknown): err is { message: string; code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'VALIDATION'
  );
}

function stripPrefix(msg: string): string {
  return msg.replace(/^\[[\w:/-]+\]\s*/, '');
}

// ─── Date serialization ───────────────────────────────────────────────────────

function serializeDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  try {
    return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
  } catch {
    return null;
  }
}

function serializeRequiredTagView(t: RequiredTagView): SerializedRequiredTagView {
  return {
    id: t.id,
    requiredTag: t.requiredTag,
    createdBy: t.createdBy,
    createdAt: serializeDate(t.createdAt) ?? '',
  };
}

// ─── getResourceRequiredTagsAction ────────────────────────────────────────────

export type GetResourceRequiredTagsActionResult =
  | { ok: true; tags: SerializedRequiredTagView[] }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getResourceRequiredTagsAction(input: {
  resourceId: string;
}): Promise<GetResourceRequiredTagsActionResult> {
  const session = await auth();
  try {
    const result = await getResourceRequiredTags(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, tags: result.tags.map(serializeRequiredTagView) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── addResourceRequiredTagAction ─────────────────────────────────────────────

export type AddResourceRequiredTagActionResult =
  | { ok: true; tags: SerializedRequiredTagView[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'duplicate' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function addResourceRequiredTagAction(input: {
  resourceId: string;
  requiredTag: string;
}): Promise<AddResourceRequiredTagActionResult> {
  const session = await auth();
  try {
    const result = await addResourceRequiredTag(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, tags: result.tags.map(serializeRequiredTagView) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── removeResourceRequiredTagAction ─────────────────────────────────────────

export type RemoveResourceRequiredTagActionResult =
  | { ok: true; tags: SerializedRequiredTagView[] }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function removeResourceRequiredTagAction(input: {
  resourceId: string;
  requirementId: string;
}): Promise<RemoveResourceRequiredTagActionResult> {
  const session = await auth();
  try {
    const result = await removeResourceRequiredTag(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, tags: result.tags.map(serializeRequiredTagView) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── getDispatchConfigAction ──────────────────────────────────────────────────

export type GetDispatchConfigActionResult =
  | { ok: true; config: DispatchConfigView }
  | AuthErrorResult
  | ServerErrorResult;

export async function getDispatchConfigAction(): Promise<GetDispatchConfigActionResult> {
  const session = await auth();
  try {
    const config = await getDispatchConfig(session);
    // getDispatchConfig always returns DispatchConfigView (no ok:false arm)
    return { ok: true, config };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── updateDispatchConfigAction ───────────────────────────────────────────────

export type UpdateDispatchConfigActionResult =
  | { ok: true; config: DispatchConfigView }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function updateDispatchConfigAction(
  input: UpdateDispatchConfigInput,
): Promise<UpdateDispatchConfigActionResult> {
  const session = await auth();
  try {
    const result = await updateDispatchConfig(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, config: result.config };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}
