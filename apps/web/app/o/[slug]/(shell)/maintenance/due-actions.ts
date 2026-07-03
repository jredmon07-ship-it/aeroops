/**
 * due-actions.ts — Server actions for the maintenance-due module (Slice P1.5).
 *
 * Pattern mirrors maintenance/actions.ts + maintenance/work-orders/actions.ts:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability inside the fn).
 *   3. Map ForbiddenError / UnauthenticatedError → { error: 'forbidden'|'unauthenticated' }.
 *   4. Map ValidationError → { error: 'validation', message }.
 *   5. Dates serialized to ISO strings at the action boundary (Dates are NOT
 *      JSON-serializable across the RSC → client boundary).
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 * RLS + org_id scoping are enforced inside the API functions.
 *
 * COMPLIANCE: MaintenanceDueView.status is ARITHMETIC on operator-entered
 * thresholds — NOT a computed FAA/Part-43/91.409 airworthiness or
 * inspection-due determination. [VERIFY-P1.5-A]
 */
'use server';

import { auth } from '@/auth';
import {
  createMaintenanceItem,
  updateMaintenanceItem,
  deactivateMaintenanceItem,
  markMaintenanceItemServiced,
  listMaintenanceDue,
  getMaintenanceDueSummary,
  notifyMaintenanceDue,
  ForbiddenError,
  UnauthenticatedError,
} from '@aeroops/api';
import type {
  MaintenanceItemView,
  MaintenanceDueView,
  MaintenanceDueSummary,
  CreateMaintenanceItemResult,
  UpdateMaintenanceItemResult,
  DeactivateMaintenanceItemResult,
  MarkMaintenanceItemServicedResult,
  NotifyMaintenanceDueResult,
} from '@aeroops/api';

// ─── Error shapes (same pattern as maintenance/actions.ts) ───────────────────

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

// ─── Date serialization ───────────────────────────────────────────────────────

function serializeDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  try {
    return d instanceof Date ? d.toISOString() : new Date(d as unknown as string).toISOString();
  } catch {
    return null;
  }
}

export interface SerializedMaintenanceItemView extends Omit<MaintenanceItemView, 'createdAt' | 'updatedAt'> {
  createdAt: string;
  updatedAt: string;
}

export interface SerializedMaintenanceDueView
  extends Omit<MaintenanceDueView, 'createdAt' | 'updatedAt'> {
  createdAt: string;
  updatedAt: string;
}

function serializeItem(item: MaintenanceItemView): SerializedMaintenanceItemView {
  return {
    ...item,
    createdAt: serializeDate(item.createdAt) ?? '',
    updatedAt: serializeDate(item.updatedAt) ?? '',
  };
}

function serializeDueView(view: MaintenanceDueView): SerializedMaintenanceDueView {
  return {
    ...view,
    createdAt: serializeDate(view.createdAt) ?? '',
    updatedAt: serializeDate(view.updatedAt) ?? '',
  };
}

// ─── createMaintenanceItemAction ──────────────────────────────────────────────

export type CreateMaintenanceItemActionResult =
  | { ok: true; item: SerializedMaintenanceItemView }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function createMaintenanceItemAction(input: {
  resourceId: string;
  title: string;
  trackBy: 'hours' | 'date';
  meterBasis?: 'hobbs' | 'tach';
  dueValueHours?: number;
  dueDate?: string;
  warnThresholdHours?: number;
  warnLeadDays?: number;
  notes?: string;
}): Promise<CreateMaintenanceItemActionResult> {
  const session = await auth();
  try {
    const result: CreateMaintenanceItemResult = await createMaintenanceItem(session, input);
    return { ok: true, item: serializeItem(result.item) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── updateMaintenanceItemAction ──────────────────────────────────────────────

export type UpdateMaintenanceItemActionResult =
  | { ok: true; item: SerializedMaintenanceItemView }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function updateMaintenanceItemAction(input: {
  itemId: string;
  title?: string;
  dueValueHours?: number;
  dueDate?: string;
  warnThresholdHours?: number | null;
  warnLeadDays?: number | null;
  notes?: string | null;
}): Promise<UpdateMaintenanceItemActionResult> {
  const session = await auth();
  try {
    const result: UpdateMaintenanceItemResult = await updateMaintenanceItem(session, input);
    if (!result.ok) return result;
    return { ok: true, item: serializeItem(result.item) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── deactivateMaintenanceItemAction ──────────────────────────────────────────

export type DeactivateMaintenanceItemActionResult =
  | { ok: true; item: SerializedMaintenanceItemView; alreadyInactive: boolean }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function deactivateMaintenanceItemAction(input: {
  itemId: string;
}): Promise<DeactivateMaintenanceItemActionResult> {
  const session = await auth();
  try {
    const result: DeactivateMaintenanceItemResult = await deactivateMaintenanceItem(session, input);
    if (!result.ok) return result;
    return { ok: true, item: serializeItem(result.item), alreadyInactive: result.alreadyInactive };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── markMaintenanceItemServicedAction ────────────────────────────────────────

export type MarkMaintenanceItemServicedActionResult =
  | { ok: true; item: SerializedMaintenanceItemView }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function markMaintenanceItemServicedAction(input: {
  itemId: string;
  newDueValueHours?: number;
  newDueDate?: string;
  note?: string;
}): Promise<MarkMaintenanceItemServicedActionResult> {
  const session = await auth();
  try {
    const result: MarkMaintenanceItemServicedResult = await markMaintenanceItemServiced(session, input);
    if (!result.ok) return result;
    return { ok: true, item: serializeItem(result.item) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── listMaintenanceDueAction ─────────────────────────────────────────────────

export type ListMaintenanceDueActionResult =
  | { ok: true; items: SerializedMaintenanceDueView[] }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function listMaintenanceDueAction(input?: {
  resourceId?: string;
}): Promise<ListMaintenanceDueActionResult> {
  const session = await auth();
  try {
    const items = await listMaintenanceDue(session, input ?? {});
    return { ok: true, items: items.map(serializeDueView) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── getMaintenanceDueSummaryAction ───────────────────────────────────────────

export type GetMaintenanceDueSummaryActionResult =
  | { ok: true; summary: MaintenanceDueSummary }
  | AuthErrorResult
  | ServerErrorResult;

export async function getMaintenanceDueSummaryAction(): Promise<GetMaintenanceDueSummaryActionResult> {
  const session = await auth();
  try {
    const summary = await getMaintenanceDueSummary(session);
    return { ok: true, summary };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── notifyMaintenanceDueAction ───────────────────────────────────────────────

export type NotifyMaintenanceDueActionResult =
  | { ok: true; result: NotifyMaintenanceDueResult }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function notifyMaintenanceDueAction(input?: {
  resourceId?: string;
}): Promise<NotifyMaintenanceDueActionResult> {
  const session = await auth();
  try {
    const result = await notifyMaintenanceDue(session, input ?? {});
    return { ok: true, result };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}
