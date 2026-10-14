/**
 * maintenance/work-orders/actions.ts — Server actions for the work-order module
 * (Slice M1.3).
 *
 * Pattern mirrors maintenance/actions.ts exactly:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability inside the fn).
 *   3. Map ForbiddenError / UnauthenticatedError → { error: 'forbidden'|'unauthenticated' }.
 *   4. Map ValidationError → { error: 'validation', message }.
 *   5. Pass through ok:false arms as-is (operational refusals are values, not errors).
 *
 * Dates are serialized to ISO strings at the action boundary so RSC → client
 * components receive plain JSON (Dates are NOT JSON-serializable).
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 * RLS + org_id scoping are enforced inside the API functions.
 *
 * COMPLIANCE [VERIFY-M1-A/C/D]: sign-off is operator data entry, NOT an FAA
 * return-to-service or §43.9/§43.11 determination. Ungrounding is an explicit
 * operator action, not a computed clearance.
 */
'use server';

import { serializeDate } from '@/lib/serialize-date';

import { actionAuth as auth } from '@/lib/action-auth';
import {
  listWorkOrders,
  getWorkOrderDetail,
  openWorkOrder,
  updateWorkOrderStatus,
  completeWorkOrder,
  cancelWorkOrder,
  listSquawks,
} from '@aeroops/api';
import type {
  WorkOrderView,
  SquawkView,
  OpenWorkOrderResult,
  UpdateWorkOrderStatusResult,
  CompleteWorkOrderResult,
  CancelWorkOrderResult,
} from '@aeroops/api';

// ─── Error shapes ─────────────────────────────────────────────────────────────

import { mapAuthError, isValidationError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ValidationErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ValidationErrorResult, ServerErrorResult };

// ─── Date serialization helpers ───────────────────────────────────────────────
// ─── Serialized WorkOrderView (Dates → string) ────────────────────────────────

export interface SerializedWorkOrderView {
  id: string;
  orgId: string;
  resourceId: string;
  squawkId: string | null;
  title: string;
  description: string | null;
  status: 'open' | 'in_progress' | 'completed' | 'cancelled';
  workPerformed: string | null;
  openedBy: string;
  openedAt: string;
  signedOffBy: string | null;
  signedOffAt: string | null;
  signOffNotes: string | null;
  cancelledReason: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SerializedSquawkView {
  id: string;
  resourceId: string;
  dispatchTicketId: string | null;
  title: string;
  description: string | null;
  severity: string;
  status: string;
  reportedBy: string;
  reportedAt: string;
  resolutionNotes: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

function serializeWorkOrder(wo: WorkOrderView): SerializedWorkOrderView {
  return {
    id: wo.id,
    orgId: wo.orgId,
    resourceId: wo.resourceId,
    squawkId: wo.squawkId,
    title: wo.title,
    description: wo.description,
    status: wo.status,
    workPerformed: wo.workPerformed,
    openedBy: wo.openedBy,
    openedAt: serializeDate(wo.openedAt) ?? '',
    signedOffBy: wo.signedOffBy,
    signedOffAt: serializeDate(wo.signedOffAt),
    signOffNotes: wo.signOffNotes,
    cancelledReason: wo.cancelledReason,
    cancelledAt: serializeDate(wo.cancelledAt),
    createdAt: serializeDate(wo.createdAt) ?? '',
    updatedAt: serializeDate(wo.updatedAt) ?? '',
  };
}

function serializeSquawk(s: SquawkView): SerializedSquawkView {
  return {
    id: s.id,
    resourceId: s.resourceId,
    dispatchTicketId: s.dispatchTicketId,
    title: s.title,
    description: s.description,
    severity: s.severity,
    status: s.status,
    reportedBy: s.reportedBy,
    reportedAt: serializeDate(s.reportedAt) ?? '',
    resolutionNotes: s.resolutionNotes,
    resolvedBy: s.resolvedBy,
    resolvedAt: serializeDate(s.resolvedAt),
  };
}

// ─── listWorkOrdersAction ─────────────────────────────────────────────────────

export type ListWorkOrdersActionResult =
  | { ok: true; workOrders: SerializedWorkOrderView[] }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function listWorkOrdersAction(input?: {
  resourceId?: string;
  status?: 'open' | 'in_progress' | 'completed' | 'cancelled';
}): Promise<ListWorkOrdersActionResult> {
  const session = await auth();
  try {
    const result = await listWorkOrders(session, input ?? {});
    return { ok: true, workOrders: result.workOrders.map(serializeWorkOrder) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}

// ─── getWorkOrderDetailAction ─────────────────────────────────────────────────

export type GetWorkOrderDetailActionResult =
  | { ok: true; workOrder: SerializedWorkOrderView; squawk: SerializedSquawkView | null }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getWorkOrderDetailAction(input: {
  workOrderId: string;
}): Promise<GetWorkOrderDetailActionResult> {
  const session = await auth();
  try {
    const result = await getWorkOrderDetail(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return {
      ok: true,
      workOrder: serializeWorkOrder(result.workOrder),
      squawk: result.squawk ? serializeSquawk(result.squawk) : null,
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}

// ─── openWorkOrderAction ──────────────────────────────────────────────────────

export type OpenWorkOrderActionResult =
  | { ok: true; workOrder: SerializedWorkOrderView }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function openWorkOrderAction(input: {
  resourceId: string;
  title: string;
  description?: string;
  squawkId?: string;
  workPerformed?: string;
}): Promise<OpenWorkOrderActionResult> {
  const session = await auth();
  try {
    const result: OpenWorkOrderResult = await openWorkOrder(session, input);
    return { ok: true, workOrder: serializeWorkOrder(result.workOrder) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}

// ─── updateWorkOrderStatusAction ──────────────────────────────────────────────

export type UpdateWorkOrderStatusActionResult =
  | { ok: true; workOrder: SerializedWorkOrderView }
  | { ok: false; reason: 'not_found' | 'invalid_transition' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function updateWorkOrderStatusAction(input: {
  workOrderId: string;
  status: 'in_progress';
}): Promise<UpdateWorkOrderStatusActionResult> {
  const session = await auth();
  try {
    const result: UpdateWorkOrderStatusResult = await updateWorkOrderStatus(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, workOrder: serializeWorkOrder(result.workOrder) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}

// ─── completeWorkOrderAction ──────────────────────────────────────────────────

export type SerializedCompleteWorkOrderResult =
  | {
      ok: true;
      workOrder: SerializedWorkOrderView;
      squawk: SerializedSquawkView | null;
      squawkResolveSkipped?: 'no_linked_squawk' | 'already_resolved_or_deferred';
      ungrounded: boolean;
      ungroundSkipped?: 'not_grounded' | 'grounded_for_other_reason' | 'no_matching_grounding_basis';
    }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_completable' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function completeWorkOrderAction(input: {
  workOrderId: string;
  workPerformed?: string;
  signOffNotes?: string;
  resolveSquawk?: boolean;
  squawkResolutionNotes?: string;
  unground?: boolean;
}): Promise<SerializedCompleteWorkOrderResult> {
  const session = await auth();
  try {
    const result: CompleteWorkOrderResult = await completeWorkOrder(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return {
      ok: true,
      workOrder: serializeWorkOrder(result.workOrder),
      squawk: result.squawk ? serializeSquawk(result.squawk) : null,
      squawkResolveSkipped: result.squawkResolveSkipped,
      ungrounded: result.ungrounded,
      ungroundSkipped: result.ungroundSkipped,
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}

// ─── cancelWorkOrderAction ────────────────────────────────────────────────────

export type CancelWorkOrderActionResult =
  | { ok: true; workOrder: SerializedWorkOrderView }
  | { ok: false; reason: 'not_found' | 'not_cancellable' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function cancelWorkOrderAction(input: {
  workOrderId: string;
  cancelledReason: string;
}): Promise<CancelWorkOrderActionResult> {
  const session = await auth();
  try {
    const result: CancelWorkOrderResult = await cancelWorkOrder(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, workOrder: serializeWorkOrder(result.workOrder) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}

// ─── listSquawksForAircraftAction ─────────────────────────────────────────────
// Used by the Open work order dialog to populate the linked-squawk picker.

export type ListSquawksForAircraftActionResult =
  | { ok: true; squawks: SerializedSquawkView[] }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function listSquawksForAircraftAction(input: {
  resourceId: string;
}): Promise<ListSquawksForAircraftActionResult> {
  const session = await auth();
  try {
    // Fetch open + deferred squawks for this aircraft for the squawk picker.
    const [openResult, deferredResult] = await Promise.all([
      listSquawks(session, { resourceId: input.resourceId, status: 'open' }),
      listSquawks(session, { resourceId: input.resourceId, status: 'deferred' }),
    ]);
    const squawks = [...openResult, ...deferredResult].sort(
      (a, b) => b.reportedAt.getTime() - a.reportedAt.getTime(),
    );
    return { ok: true, squawks: squawks.map(serializeSquawk) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}
