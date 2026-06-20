/**
 * maintenance/work-order-types.ts — public result/IO types for the work-order
 * write paths (Slice M1.2). Framework-agnostic; no I/O.
 *
 * DESIGN POSTURE (mirrors maintenance/types.ts):
 *   - Operational refusals (not_found, not_completable, not_cancellable, etc.)
 *     are RETURNED as discriminated-union values, NOT thrown.
 *   - Auth failures (ForbiddenError / UnauthenticatedError) are THROWN.
 *   - Validation failures (bad input, cross-org, non-aircraft) are THROWN as
 *     ValidationError.
 *
 * COMPLIANCE (HARD COMPLIANCE LINE §M1):
 *   A work order, its sign-off, and 'completed' status are OPERATOR DATA /
 *   data entry. The software asserts NO airworthiness, return-to-service
 *   (§43.9/§43.11), AD compliance, inspection currency, or MEL status.
 *   'completed' ≠ FAA RTS. [VERIFY-M1-A/B/C/D]
 *
 * ADDITIVE: do NOT modify existing maintenance types.
 */

import type { SquawkView, GroundingEventView } from './types.js';

// ─── WorkOrderView ────────────────────────────────────────────────────────────

/**
 * WorkOrderView — a work_order row as seen by API callers.
 *
 * Write-once fields: resourceId, squawkId, title, description, openedBy, openedAt.
 * Mutable while open/in_progress: workPerformed.
 * Terminal fields (set on complete): signedOffBy, signedOffAt, signOffNotes.
 * Terminal fields (set on cancel): cancelledReason, cancelledAt.
 */
export interface WorkOrderView {
  id: string;
  orgId: string;
  resourceId: string;
  /** Linked squawk (write-once). null when WO was opened without a squawk link,
   *  or when the linked squawk was hard-deleted (ON DELETE SET NULL). */
  squawkId: string | null;
  title: string;
  description: string | null;
  status: 'open' | 'in_progress' | 'completed' | 'cancelled';
  workPerformed: string | null;
  openedBy: string;
  openedAt: Date;
  /** Null until completed. SET NULL on user hard-delete — durable who in audit_log. [VERIFY-M1-C] */
  signedOffBy: string | null;
  signedOffAt: Date | null;
  signOffNotes: string | null;
  cancelledReason: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── openWorkOrder result ─────────────────────────────────────────────────────

/**
 * OpenWorkOrderResult — discriminated union for openWorkOrder.
 *
 * Everything invalid (cross-org resource, non-aircraft, inactive, cross-org
 * squawk, squawk-on-wrong-aircraft) THROWS ValidationError.
 * ok:true → work order inserted + audit written.
 */
export type OpenWorkOrderResult =
  | { ok: true; workOrder: WorkOrderView };

// ─── listWorkOrders result ────────────────────────────────────────────────────

/**
 * ListWorkOrdersResult — plain list (no pagination in M1, ORDER BY created_at DESC LIMIT 50).
 */
export type ListWorkOrdersResult =
  | { ok: true; workOrders: WorkOrderView[] };

// ─── getWorkOrderDetail result ────────────────────────────────────────────────

/**
 * GetWorkOrderDetailResult — discriminated union for getWorkOrderDetail.
 *
 *   ok:true            → found in org; includes linked squawk when present.
 *   ok:false not_found → not visible (cross-org RLS block or absent).
 */
export type GetWorkOrderDetailResult =
  | { ok: true; workOrder: WorkOrderView; squawk: SquawkView | null }
  | { ok: false; reason: 'not_found' };

// ─── updateWorkOrderStatus result ─────────────────────────────────────────────

/**
 * UpdateWorkOrderStatusResult — discriminated union for updateWorkOrderStatus.
 *
 *   ok:true                       → status moved to 'in_progress'; audit written.
 *   ok:false not_found            → WO not visible in org.
 *   ok:false invalid_transition   → WO exists but is not 'open' (terminal or
 *                                    already in_progress; concurrent write).
 */
export type UpdateWorkOrderStatusResult =
  | { ok: true; workOrder: WorkOrderView }
  | { ok: false; reason: 'not_found' | 'invalid_transition' };

// ─── completeWorkOrder result ─────────────────────────────────────────────────

/**
 * CompleteWorkOrderResult — discriminated union for completeWorkOrder.
 *
 *   ok:true → WO completed + optional squawk-resolve + optional unground.
 *     - workOrder         : the completed WO view.
 *     - squawk            : resolved squawk view (if resolveSquawk and WO had a
 *                           linked squawk and it was open). null otherwise.
 *     - squawkResolveSkipped : 'no_linked_squawk' | 'already_resolved_or_deferred'
 *                              when resolve was requested but skipped. undefined otherwise.
 *     - grounding         : the new 'released' grounding event view (if unground
 *                           was requested and the aircraft was grounded for this
 *                           squawk). null otherwise.
 *     - ungrounded        : true when a new 'released' event was written.
 *     - ungroundSkipped   : skip reason if unground was requested but skipped.
 *
 *   ok:false not_found      → WO not visible in org.
 *   ok:false not_completable → WO exists but is already completed or cancelled.
 */
export type CompleteWorkOrderResult =
  | {
      ok: true;
      workOrder: WorkOrderView;
      squawk: SquawkView | null;
      squawkResolveSkipped?: 'no_linked_squawk' | 'already_resolved_or_deferred';
      grounding: GroundingEventView | null;
      ungrounded: boolean;
      ungroundSkipped?: 'not_grounded' | 'grounded_for_other_reason' | 'no_matching_grounding_basis';
    }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_completable' };

// ─── cancelWorkOrder result ───────────────────────────────────────────────────

/**
 * CancelWorkOrderResult — discriminated union for cancelWorkOrder.
 *
 *   ok:true                  → WO cancelled; audit written.
 *                               Does NOT resolve squawk or unground aircraft.
 *   ok:false not_found       → WO not visible in org.
 *   ok:false not_cancellable → WO is already completed or cancelled.
 */
export type CancelWorkOrderResult =
  | { ok: true; workOrder: WorkOrderView }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_cancellable' };
