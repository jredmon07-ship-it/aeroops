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
 *
 * ADR-0008 §2.2: current grounding state = latest event per aircraft, resolved
 * via DISTINCT ON (resource_id) ORDER BY resource_id, created_at DESC, id DESC.
 * "latest 'released' or absent" ⇒ grounded:false.
 *
 * Runs on the passed tx (RLS-scoped by caller — org GUC already set).
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import type { SquawkView } from './types.js';

// ─── Grounding probe result ───────────────────────────────────────────────────

export interface GroundingProbeEntry {
  grounded: boolean;
  reason: string | null;
  since: Date | null;
  groundedBy: string | null;
  eventId: string | null;
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
    result.set(id, { grounded: false, reason: null, since: null, groundedBy: null, eventId: null });
  }

  if (resourceIds.length === 0) return result;

  // Build parameterised uuid[] for `= ANY(ARRAY[...])`.
  const idList = sql.join(
    resourceIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  // DISTINCT ON picks the latest event per aircraft (created_at DESC, id DESC
  // as tie-breaker). RLS is enforced by the GUC already set by the caller.
  const queryResult = await tx.execute(sql`
    SELECT DISTINCT ON (resource_id)
      id          AS "eventId",
      resource_id AS "resourceId",
      state,
      reason,
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
    });
  }

  return result;
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
