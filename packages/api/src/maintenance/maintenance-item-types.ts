/**
 * maintenance-item-types.ts — public result/IO types for the maintenance-due
 * write + read paths (Slice P1.5). Framework-agnostic; no I/O.
 *
 * DESIGN POSTURE (mirrors work-order-types.ts / types.ts):
 *   - Operational refusals (not_found) are RETURNED as discriminated-union
 *     values, NOT thrown. The UI renders them.
 *   - Auth failures are THROWN as ForbiddenError / UnauthenticatedError.
 *   - Validation failures (bad input, non-aircraft, inactive, cross-org-
 *     invisible, malformed track_by/meter_basis shape) are THROWN as
 *     ValidationError.
 *
 * COMPLIANCE (HARD LINE): a maintenance_item's thresholds are OPERATOR-
 * ENTERED tracking data. MaintenanceDueView.status is ARITHMETIC (via
 * @aeroops/core's evaluateMaintenanceDue) comparing that threshold to a
 * recorded meter/date — NOT a computed FAA/Part-43/91.409 airworthiness or
 * inspection-due DETERMINATION. [VERIFY-P1.5-A]
 */
import type { MaintenanceTrackBy, MeterBasis, MaintenanceDueStatus } from '@aeroops/core';

// ─── MaintenanceItemView ──────────────────────────────────────────────────────

/**
 * MaintenanceItemView — a maintenance_item row as seen by API callers.
 *
 * Write-once fields: resourceId, trackBy, meterBasis, createdBy. Mutable:
 * title, dueValueHours, dueDate, warnThresholdHours, warnLeadDays, notes,
 * active.
 */
export interface MaintenanceItemView {
  id: string;
  resourceId: string;
  title: string;
  trackBy: MaintenanceTrackBy;
  meterBasis: MeterBasis | null;
  dueValueHours: number | null;
  /** ISO calendar date 'YYYY-MM-DD', or null for hours-tracked items. */
  dueDate: string | null;
  warnThresholdHours: number | null;
  warnLeadDays: number | null;
  notes: string | null;
  active: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── MaintenanceDueView ───────────────────────────────────────────────────────

/**
 * MaintenanceDueView — a MaintenanceItemView plus its computed due status
 * (evaluateMaintenanceDue's output, joined with the aircraft's last-recorded
 * meters). Returned by listMaintenanceDue.
 */
export interface MaintenanceDueView extends MaintenanceItemView {
  status: MaintenanceDueStatus;
  remainingHours?: number;
  remainingDays?: number;
  /** The aircraft's last-recorded meters used for evaluation (DISPLAY-ONLY). */
  currentHobbs: number | null;
  currentTach: number | null;
}

// ─── MaintenanceDueSummary ────────────────────────────────────────────────────

/** MaintenanceDueSummary — point-in-time overdue/due_soon counts (dashboard tile). */
export interface MaintenanceDueSummary {
  overdueCount: number;
  dueSoonCount: number;
  okCount: number;
  unknownCount: number;
}

// ─── createMaintenanceItem result ────────────────────────────────────────────

/**
 * CreateMaintenanceItemResult — discriminated union for createMaintenanceItem.
 *
 *   ok:true → item inserted; audit written.
 *
 * Everything invalid THROWS (ValidationError / ForbiddenError / UnauthenticatedError).
 */
export type CreateMaintenanceItemResult =
  | { ok: true; item: MaintenanceItemView };

// ─── updateMaintenanceItem result ────────────────────────────────────────────

/**
 * UpdateMaintenanceItemResult — discriminated union for updateMaintenanceItem.
 *
 *   ok:true            → mutable fields updated; audit written.
 *   ok:false not_found → item not visible in the session org.
 */
export type UpdateMaintenanceItemResult =
  | { ok: true; item: MaintenanceItemView }
  | { ok: false; reason: 'not_found' };

// ─── deactivateMaintenanceItem result ────────────────────────────────────────

/**
 * DeactivateMaintenanceItemResult — discriminated union for
 * deactivateMaintenanceItem.
 *
 *   ok:true alreadyInactive:true  → item was already inactive; NO audit row.
 *   ok:true alreadyInactive:false → active set false; audit written.
 *   ok:false not_found            → item not visible in the session org.
 */
export type DeactivateMaintenanceItemResult =
  | { ok: true; item: MaintenanceItemView; alreadyInactive: boolean }
  | { ok: false; reason: 'not_found' };

// ─── markMaintenanceItemServiced result ──────────────────────────────────────

/**
 * MarkMaintenanceItemServicedResult — discriminated union for
 * markMaintenanceItemServiced.
 *
 *   ok:true            → due threshold advanced; audit written
 *                         (action='maintenance_item.serviced').
 *   ok:false not_found → item not visible in the session org.
 */
export type MarkMaintenanceItemServicedResult =
  | { ok: true; item: MaintenanceItemView }
  | { ok: false; reason: 'not_found' };
