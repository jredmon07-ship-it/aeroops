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

import { serializeDate } from '@/lib/serialize-date';

import { actionAuth as auth } from '@/lib/action-auth';
import {
  createMaintenanceItem,
  updateMaintenanceItem,
  deactivateMaintenanceItem,
  markMaintenanceItemServiced,
  listMaintenanceDue,
  getMaintenanceDueSummary,
  notifyMaintenanceDue,
  getAircraftDetail,
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

import { mapAuthError, isValidationError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ValidationErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ValidationErrorResult, ServerErrorResult };

function stripPrefix(msg: string): string {
  return msg.replace(/^\[[\w:]+\]\s*/, '');
}

// ─── Date serialization ───────────────────────────────────────────────────────
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

// ─── seedCommonRemindersAction ────────────────────────────────────────────────
//
// One-click "Add common reminders" for an aircraft with ZERO tracked items:
// seeds six plain operator reminder items via the EXISTING createMaintenanceItem
// command (each individually editable/deactivatable afterwards — no new API
// surface, no migration). Hours items are due at CURRENT METER + interval
// (last-recorded meter from getAircraftDetail, 0 when never recorded); date
// items are due TODAY + interval days.
//
// COMPLIANCE: these are operator-entered tracking reminders with nominal
// intervals — NOT a computed Part-43/91.409 airworthiness or inspection-due
// determination. [VERIFY-P1.5-A]

/** The six common reminders (kept in sync with lib/maintenance-progress.ts COMMON_REMINDER_INTERVALS). */
const COMMON_REMINDER_SEEDS: ReadonlyArray<
  | { title: string; trackBy: 'hours'; intervalHours: number; warnThresholdHours: number }
  | { title: string; trackBy: 'date'; intervalDays: number; warnLeadDays: number }
> = [
  { title: '50 Hour Oil Change', trackBy: 'hours', intervalHours: 50, warnThresholdHours: 10 },
  { title: '100 Hour Inspection', trackBy: 'hours', intervalHours: 100, warnThresholdHours: 10 },
  { title: 'Annual Inspection', trackBy: 'date', intervalDays: 365, warnLeadDays: 30 },
  { title: 'ELT Battery', trackBy: 'date', intervalDays: 365, warnLeadDays: 30 },
  { title: 'Transponder Check', trackBy: 'date', intervalDays: 730, warnLeadDays: 60 },
  { title: 'Pitot/Static Check', trackBy: 'date', intervalDays: 730, warnLeadDays: 60 },
];

/** today + n days as 'YYYY-MM-DD' (UTC calendar math — no tz drift). */
function isoDatePlusDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export type SeedCommonRemindersActionResult =
  | { ok: true; items: SerializedMaintenanceDueView[] }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function seedCommonRemindersAction(input: {
  resourceId: string;
}): Promise<SeedCommonRemindersActionResult> {
  const session = await auth();
  try {
    // Guard: only for an aircraft with ZERO active items (double-click /
    // stale-UI protection — the button is also hidden otherwise).
    const existing = await listMaintenanceDue(session, { resourceId: input.resourceId });
    if (existing.length > 0) {
      return {
        error: 'validation',
        message: 'This aircraft already has maintenance items — add further reminders individually.',
      };
    }

    // Last-recorded meters (DISPLAY-ONLY read) → hours items are due at
    // current meter + interval. Never-recorded meter → interval from zero.
    const detailResult = await getAircraftDetail(session, { resourceId: input.resourceId });
    if (!detailResult.ok) {
      return { error: 'validation', message: 'Aircraft not found.' };
    }
    const detail = detailResult.aircraft;
    const meterBasis: 'hobbs' | 'tach' = detail.hasHobbs || !detail.hasTach ? 'hobbs' : 'tach';
    const currentMeter =
      (meterBasis === 'hobbs' ? detail.currentHobbs : detail.currentTach) ?? 0;

    for (const seed of COMMON_REMINDER_SEEDS) {
      if (seed.trackBy === 'hours') {
        await createMaintenanceItem(session, {
          resourceId: input.resourceId,
          title: seed.title,
          trackBy: 'hours',
          meterBasis,
          dueValueHours: Math.round((currentMeter + seed.intervalHours) * 10) / 10,
          warnThresholdHours: seed.warnThresholdHours,
        });
      } else {
        await createMaintenanceItem(session, {
          resourceId: input.resourceId,
          title: seed.title,
          trackBy: 'date',
          dueDate: isoDatePlusDays(seed.intervalDays),
          warnLeadDays: seed.warnLeadDays,
        });
      }
    }

    // Return the freshly evaluated due views so the list updates in place.
    const items = await listMaintenanceDue(session, { resourceId: input.resourceId });
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
