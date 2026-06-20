/**
 * maintenance/internal.ts — shared internals for the maintenance write paths.
 *
 * NOT exported from @aeroops/api. Holds:
 *   - loadGroundingProbe — reusable tx-level grounding status probe.
 *     Imported by ground-aircraft.ts, grounding-status.ts, AND open-dispatch.ts
 *     (Wave 3b grounding block integration).
 *   - toSquawkView — pure mapper from a squawk DB row to the SquawkView shape.
 *     Lives here (not in report-squawk.ts) so fleet read paths can import it
 *     via a static top-level import without pulling in the write-side module.
 *     report-squawk.ts re-exports it for backward compatibility.
 *   - applySquawkStatusOnTx — inner-core helper for resolving a squawk inside
 *     an existing tx (used by updateSquawkStatus + completeWorkOrder).
 *   - applyUngroundOnTx — inner-core helper for releasing a grounding inside
 *     an existing tx (used by unGroundAircraft + completeWorkOrder).
 *
 * ADR-0008 §2.2: current grounding state = latest event per aircraft, resolved
 * via DISTINCT ON (resource_id) ORDER BY resource_id, created_at DESC, id DESC.
 * "latest 'released' or absent" ⇒ grounded:false.
 *
 * Runs on the passed tx (RLS-scoped by caller — org GUC already set).
 */

import { sql, eq, and } from 'drizzle-orm';
import { squawk, aircraftGrounding, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import type { AppSession } from '../auth/types.js';
import type { SquawkView } from './types.js';

// ─── Grounding probe result ───────────────────────────────────────────────────

export interface GroundingProbeEntry {
  grounded: boolean;
  reason: string | null;
  since: Date | null;
  groundedBy: string | null;
  eventId: string | null;
  /**
   * squawkId — the squawk linked to the latest grounding event (null when the
   * aircraft is not grounded, when the event had no squawk link, or when the
   * linked squawk was hard-deleted via ON DELETE SET NULL).
   *
   * Added in Slice M1.2 (additive; existing callers — fleet/openDispatch — do
   * not read this field and are unaffected).
   */
  squawkId: string | null;
}

// ─── loadGroundingProbe ───────────────────────────────────────────────────────

/**
 * loadGroundingProbe — returns current grounding state for each resourceId.
 *
 * One query: DISTINCT ON (resource_id) ORDER BY resource_id, created_at DESC, id DESC
 * selects the latest aircraft_grounding event per aircraft. State 'grounded' →
 * grounded:true; 'released' or absent → grounded:false.
 *
 * Runs on the passed tx (RLS-scoped by the caller's withSessionOrgContextWithDb or
 * withOrgContext call). NEVER sets org context itself.
 *
 * @param tx         - Active Drizzle tx with org GUC already set.
 * @param resourceIds - The aircraft resource IDs to probe (may be empty → empty Map).
 * @returns Map<resourceId, GroundingProbeEntry> — every id keyed (absent ids get
 *          grounded:false, all nulls, since it means no events).
 */
export async function loadGroundingProbe(
  tx: AnyDb,
  resourceIds: string[],
): Promise<Map<string, GroundingProbeEntry>> {
  // Initialise all requested ids to "not grounded" as the default.
  const result = new Map<string, GroundingProbeEntry>();
  for (const id of resourceIds) {
    result.set(id, { grounded: false, reason: null, since: null, groundedBy: null, eventId: null, squawkId: null });
  }

  if (resourceIds.length === 0) return result;

  // Build parameterised uuid[] for `= ANY(ARRAY[...])`.
  const idList = sql.join(
    resourceIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  // DISTINCT ON picks the latest event per aircraft (created_at DESC, id DESC
  // as tie-breaker). RLS is enforced by the GUC already set by the caller.
  // squawk_id is projected additively (Slice M1.2); existing callers ignore it.
  const queryResult = await tx.execute(sql`
    SELECT DISTINCT ON (resource_id)
      id          AS "eventId",
      resource_id AS "resourceId",
      state,
      reason,
      squawk_id   AS "squawkId",
      created_by  AS "groundedBy",
      created_at  AS "since"
    FROM aircraft_grounding
    WHERE resource_id = ANY(ARRAY[${idList}])
    ORDER BY resource_id, created_at DESC, id DESC
  `);

  const rows = (queryResult.rows ?? queryResult) as Array<{
    eventId: string;
    resourceId: string;
    state: string;
    reason: string;
    squawkId: string | null;
    groundedBy: string;
    since: Date | string;
  }>;

  for (const row of rows) {
    const isGrounded = row.state === 'grounded';
    result.set(row.resourceId, {
      grounded: isGrounded,
      reason: isGrounded ? row.reason : null,
      since: row.since instanceof Date ? row.since : new Date(row.since),
      groundedBy: row.groundedBy,
      eventId: row.eventId,
      squawkId: isGrounded ? (row.squawkId ?? null) : null,
    });
  }

  return result;
}

// ─── applySquawkStatusOnTx ────────────────────────────────────────────────────

/**
 * ApplySquawkStatusInput — args for the tx-level squawk-status helper.
 */
export interface ApplySquawkStatusInput {
  squawkId: string;
  status: 'resolved' | 'deferred';
  resolutionNotes?: string | null;
}

/**
 * ApplySquawkStatusResult — output of applySquawkStatusOnTx.
 *
 *   ok:true            → squawk status set; ONE audit row written.
 *   ok:false not_found → squawk not visible in org (RLS-blocked or absent).
 *   ok:false not_open  → squawk exists but is not in 'open' status.
 *
 * NO requireCapability, NO context-open — caller must hold an active
 * withSessionOrgContextWithDb tx with the GUC already set.
 */
export type ApplySquawkStatusResult =
  | { ok: true; squawkRow: SquawkView }
  | { ok: false; reason: 'not_found' | 'not_open' };

/**
 * applySquawkStatusOnTx — inner-core helper: resolve/defer a squawk inside
 * an existing org-scoped tx.
 *
 * Performs the guarded UPDATE (WHERE id=$ AND status='open') + audit row.
 * Does NOT call requireCapability or withSessionOrgContextWithDb — that is
 * the caller's responsibility. Used by updateSquawkStatus (extracted) and
 * completeWorkOrder (orchestration).
 *
 * @param sess  - Active AppSession (org_id + userId for the audit row).
 * @param tx    - Active Drizzle tx with org GUC already set by caller.
 * @param input - squawkId, target status, optional resolutionNotes.
 */
export async function applySquawkStatusOnTx(
  sess: AppSession,
  tx: AnyDb,
  input: ApplySquawkStatusInput,
): Promise<ApplySquawkStatusResult> {
  const { squawkId, status, resolutionNotes } = input;

  const updated = await tx
    .update(squawk)
    .set({
      status,
      resolutionNotes: resolutionNotes ?? null,
      resolvedBy:      sess.userId,
      resolvedAt:      sql`NOW()`,
      updatedAt:       sql`NOW()`,
    })
    .where(
      and(
        eq(squawk.id, squawkId),
        eq(squawk.status, 'open'),
      ),
    )
    .returning();

  if (updated.length === 0) {
    const probe = await tx
      .select({ id: squawk.id, status: squawk.status })
      .from(squawk)
      .where(eq(squawk.id, squawkId))
      .limit(1);

    if (!probe[0]) {
      return { ok: false, reason: 'not_found' } as const;
    }
    return { ok: false, reason: 'not_open' } as const;
  }

  const row = updated[0]!;

  await tx.insert(auditLog).values({
    orgId:       sess.orgId,
    actorUserId: sess.userId,
    action:      'squawk.status_changed',
    entityType:  'squawk',
    entityId:    row.id,
    metadata: {
      squawkId,
      newStatus:       status,
      resolutionNotes: resolutionNotes ?? null,
    },
  });

  return { ok: true, squawkRow: toSquawkView(row) };
}

// ─── applyUngroundOnTx ────────────────────────────────────────────────────────

/**
 * ApplyUngroundInput — args for the tx-level unground helper.
 */
export interface ApplyUngroundInput {
  resourceId: string;
  reason?: string | null;
}

/**
 * ApplyUngroundResult — output of applyUngroundOnTx.
 *
 *   ok:true alreadyReleased:true  → aircraft was not grounded; no new row/audit.
 *   ok:true alreadyReleased:false → new 'released' event inserted; audit written.
 *
 * NO requireCapability, NO context-open — caller must hold an active
 * withSessionOrgContextWithDb tx with the GUC already set.
 */
export type ApplyUngroundResult =
  | { ok: true; alreadyReleased: true; groundingRow: null }
  | { ok: true; alreadyReleased: false; groundingRow: {
      id: string;
      resourceId: string;
      state: string;
      reason: string;
      squawkId: string | null;
      dispatchTicketId: string | null;
      createdBy: string;
      createdAt: Date | string;
    } };

/**
 * applyUngroundOnTx — inner-core helper: release an aircraft's grounding inside
 * an existing org-scoped tx.
 *
 * Loads the current grounding state via loadGroundingProbe, then (if grounded)
 * INSERTs a 'released' event + audit row. Idempotent (not-grounded → alreadyReleased).
 *
 * Does NOT call requireCapability or withSessionOrgContextWithDb — that is
 * the caller's responsibility.
 *
 * @param sess  - Active AppSession.
 * @param tx    - Active Drizzle tx with org GUC already set.
 * @param input - resourceId + optional reason text.
 */
export async function applyUngroundOnTx(
  sess: AppSession,
  tx: AnyDb,
  input: ApplyUngroundInput,
): Promise<ApplyUngroundResult> {
  const { resourceId, reason } = input;

  const probe = await loadGroundingProbe(tx, [resourceId]);
  const current = probe.get(resourceId)!;

  if (!current.grounded) {
    return { ok: true, alreadyReleased: true, groundingRow: null };
  }

  const [inserted] = await tx
    .insert(aircraftGrounding)
    .values({
      orgId:            sess.orgId,
      resourceId,
      state:            'released',
      reason:           reason ?? '',
      squawkId:         null,
      dispatchTicketId: null,
      createdBy:        sess.userId,
    })
    .returning();

  await tx.insert(auditLog).values({
    orgId:       sess.orgId,
    actorUserId: sess.userId,
    action:      'grounding.released',
    entityType:  'aircraft_grounding',
    entityId:    inserted!.id,
    metadata: {
      resourceId,
      reason: reason ?? null,
    },
  });

  return {
    ok: true,
    alreadyReleased: false,
    groundingRow: inserted!,
  };
}

// ─── toSquawkView mapper ──────────────────────────────────────────────────────

/**
 * toSquawkView — pure mapper from a squawk DB row to the public SquawkView shape.
 *
 * Lives in internal.ts so fleet read paths can import it via a static top-level
 * import without pulling in the report-squawk write module. report-squawk.ts
 * re-exports this for backward compatibility with existing callers.
 */
export function toSquawkView(row: {
  id: string;
  resourceId: string;
  dispatchTicketId: string | null;
  title: string;
  description: string | null;
  severity: string;
  status: string;
  reportedBy: string;
  reportedAt: Date | string;
  resolutionNotes: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | string | null;
}): SquawkView {
  return {
    id:               row.id,
    resourceId:       row.resourceId,
    dispatchTicketId: row.dispatchTicketId,
    title:            row.title,
    description:      row.description,
    severity:         row.severity as SquawkView['severity'],
    status:           row.status as SquawkView['status'],
    reportedBy:       row.reportedBy,
    reportedAt:       row.reportedAt instanceof Date ? row.reportedAt : new Date(row.reportedAt),
    resolutionNotes:  row.resolutionNotes,
    resolvedBy:       row.resolvedBy,
    resolvedAt:
      row.resolvedAt == null
        ? null
        : row.resolvedAt instanceof Date
          ? row.resolvedAt
          : new Date(row.resolvedAt),
  };
}

// ─── toWorkOrderView mapper ───────────────────────────────────────────────────

/**
 * toWorkOrderView — pure mapper from a work_order DB row to the public
 * WorkOrderView shape.
 *
 * Centralised here so all work-order read paths (list, detail, post-write
 * re-read) share exactly the same projection and can never diverge.
 */
export function toWorkOrderView(row: {
  id: string;
  orgId: string;
  resourceId: string;
  squawkId: string | null;
  title: string;
  description: string | null;
  status: string;
  workPerformed: string | null;
  openedBy: string;
  openedAt: Date | string;
  signedOffBy: string | null;
  signedOffAt: Date | string | null;
  signOffNotes: string | null;
  cancelledReason: string | null;
  cancelledAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): import('./work-order-types.js').WorkOrderView {
  const asDate = (v: Date | string): Date =>
    v instanceof Date ? v : new Date(v);
  const asDateOrNull = (v: Date | string | null | undefined): Date | null =>
    v == null ? null : v instanceof Date ? v : new Date(v);

  return {
    id:              row.id,
    orgId:           row.orgId,
    resourceId:      row.resourceId,
    squawkId:        row.squawkId,
    title:           row.title,
    description:     row.description,
    status:          row.status as import('./work-order-types.js').WorkOrderView['status'],
    workPerformed:   row.workPerformed,
    openedBy:        row.openedBy,
    openedAt:        asDate(row.openedAt),
    signedOffBy:     row.signedOffBy,
    signedOffAt:     asDateOrNull(row.signedOffAt),
    signOffNotes:    row.signOffNotes,
    cancelledReason: row.cancelledReason,
    cancelledAt:     asDateOrNull(row.cancelledAt),
    createdAt:       asDate(row.createdAt),
    updatedAt:       asDate(row.updatedAt),
  };
}
