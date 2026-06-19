/**
 * maintenance/actions.ts — Server actions for the maintenance module (Slice 3b).
 *
 * Pattern mirrors schedule/actions.ts exactly:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability inside the fn).
 *   3. Map ForbiddenError / UnauthenticatedError → { error: 'forbidden'|'unauthenticated' }.
 *   4. Map ValidationError → { error: 'validation', message }.
 *   5. Pass through ok:false arms as-is (operational refusals are values, not errors).
 *
 * Maps are serialized to arrays/objects — Maps are NOT JSON-serializable.
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 * RLS + org_id scoping are enforced inside the API functions.
 */
'use server';

import { auth } from '@/auth';
import {
  groundAircraft,
  unGroundAircraft,
  getGroundingStatus,
  reportSquawk,
  updateSquawkStatus,
  listSquawks,
  getOpenSquawkCounts,
  ForbiddenError,
  UnauthenticatedError,
} from '@aeroops/api';
import type {
  GroundAircraftResult,
  UnGroundResult,
  GroundingStatusView,
  ReportSquawkResult,
  UpdateSquawkStatusResult,
  SquawkView,
} from '@aeroops/api';

// ─── Error shapes (same as schedule/actions.ts) ───────────────────────────────

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
  return msg.replace(/^\[[\w:]+\]\s*/, '');
}

// ─── getGroundingStatusAction ─────────────────────────────────────────────────

/**
 * Serializes Map<resourceId, GroundingStatusView> → Array<[string, GroundingStatusView]>
 * because Maps are not JSON-serializable.
 */
export type GetGroundingStatusActionResult =
  | { ok: true; entries: Array<[string, GroundingStatusView]> }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getGroundingStatusAction(input: {
  resourceIds: string[];
}): Promise<GetGroundingStatusActionResult> {
  const session = await auth();
  try {
    const map = await getGroundingStatus(session, input);
    return { ok: true, entries: [...map.entries()] };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── groundAircraftAction ─────────────────────────────────────────────────────

export type GroundAircraftActionResult =
  | GroundAircraftResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function groundAircraftAction(input: {
  resourceId: string;
  reason: string;
  squawkId?: string;
  dispatchTicketId?: string;
}): Promise<GroundAircraftActionResult> {
  const session = await auth();
  try {
    return await groundAircraft(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── unGroundAircraftAction ───────────────────────────────────────────────────

export type UnGroundAircraftActionResult =
  | UnGroundResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function unGroundAircraftAction(input: {
  resourceId: string;
  reason?: string;
}): Promise<UnGroundAircraftActionResult> {
  const session = await auth();
  try {
    return await unGroundAircraft(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── getOpenSquawkCountsAction ────────────────────────────────────────────────

/**
 * Serializes Map<resourceId, number> → Array<[string, number]>.
 */
export type GetOpenSquawkCountsActionResult =
  | { ok: true; entries: Array<[string, number]> }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getOpenSquawkCountsAction(input: {
  resourceIds: string[];
}): Promise<GetOpenSquawkCountsActionResult> {
  const session = await auth();
  try {
    const map = await getOpenSquawkCounts(session, input);
    return { ok: true, entries: [...map.entries()] };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── reportSquawkAction ───────────────────────────────────────────────────────

export type ReportSquawkActionResult =
  | ReportSquawkResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function reportSquawkAction(input: {
  resourceId: string;
  title: string;
  description?: string;
  severity: 'low' | 'medium' | 'high' | 'grounding';
  dispatchTicketId?: string;
}): Promise<ReportSquawkActionResult> {
  const session = await auth();
  try {
    return await reportSquawk(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── updateSquawkStatusAction ─────────────────────────────────────────────────

export type UpdateSquawkStatusActionResult =
  | UpdateSquawkStatusResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function updateSquawkStatusAction(input: {
  squawkId: string;
  status: 'resolved' | 'deferred';
  resolutionNotes?: string;
}): Promise<UpdateSquawkStatusActionResult> {
  const session = await auth();
  try {
    return await updateSquawkStatus(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── listSquawksAction ────────────────────────────────────────────────────────

export type ListSquawksActionResult =
  | { ok: true; squawks: SquawkView[] }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function listSquawksAction(input?: {
  resourceId?: string;
  status?: 'open' | 'deferred' | 'resolved';
  limit?: number;
}): Promise<ListSquawksActionResult> {
  const session = await auth();
  try {
    const squawks = await listSquawks(session, input);
    return { ok: true, squawks };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}
