/**
 * reporting/get-maintenance-reminders-report.ts — getMaintenanceRemindersReport
 * (FC canned-report menu).
 *
 * Org-wide maintenance-due list for the Operational Reports page, with an
 * optional computed-status filter. Reuses the list-maintenance-due DATA SHAPE
 * (MaintenanceDueView) but under reporting:access (not maintenance:access), and
 * enriches each row with the aircraft tail number so an org-wide report is
 * readable. READ-ONLY over EXISTING tables — NO new migration.
 *
 * ── Reuse ─────────────────────────────────────────────────────────────────────
 * The load+evaluate is the SAME logic as listMaintenanceDue: this calls the
 * exported tx-level helper `loadMaintenanceDueViews` (which does its own NO
 * authz — the caller owns authz + context, mirroring its documented contract)
 * inside our OWN requireCapability('reporting:access') + withSessionOrgContext.
 * No query is duplicated; only the capability gate differs (broader
 * reporting:access audience, consistent with the maintenance-trend section).
 *
 * The `status` filter is applied in-memory because MaintenanceDueStatus is an
 * ARITHMETIC evaluation (evaluateMaintenanceDue), NOT a stored column.
 *
 * AUTHZ: requireCapability('reporting:access') FIRST.
 * TENANT ISOLATION: org_id from session only; maintenance_item + resource are
 *   RLS-scoped by the GUC — no org_id predicate needed.
 * READ-ONLY: zero writes, zero audit rows. Reads NO dispatch meter WRITE paths
 *   (loadMaintenanceDueViews uses the display-only loadCurrentMetersBatch).
 *
 * [VERIFY-M1-A] Due status is pure arithmetic on operator-entered thresholds —
 *   NOT a computed FAA/Part-43/91.409 airworthiness determination.
 *
 * TWO CALLING FORMS:
 *   getMaintenanceRemindersReport(session, input)          — app code.
 *   getMaintenanceRemindersReportWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import type { MaintenanceDueStatus } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { loadMaintenanceDueViews } from '../maintenance/list-maintenance-due.js';
import type { MaintenanceDueView } from '../maintenance/maintenance-item-types.js';
import { extractRows } from '../db-rows.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const InputSchema = z.object({
  status: z.enum(['ok', 'due_soon', 'overdue', 'unknown']).optional(),
});

export type GetMaintenanceRemindersReportInput = z.infer<typeof InputSchema>;

// ─── Output types ─────────────────────────────────────────────────────────────

export interface MaintenanceReminderReportRow extends MaintenanceDueView {
  /** Aircraft tail number ('—' when the resource has none recorded). */
  tailNumber: string;
}

export interface MaintenanceRemindersReportResult {
  rows: MaintenanceReminderReportRow[];
  overdueCount: number;
  dueSoonCount: number;
  okCount: number;
  unknownCount: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<MaintenanceRemindersReportResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'reporting:access');

  // 2. VALIDATE.
  const parsed = InputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[reporting] invalid getMaintenanceRemindersReport input: ${first?.message ?? 'unknown'}`,
    );
  }
  const statusFilter = parsed.data.status as MaintenanceDueStatus | undefined;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Reuse the exact load+evaluate from listMaintenanceDue (org-wide → undefined).
    const views = await loadMaintenanceDueViews(tx, undefined);

    // Counts are over the FULL org (before any status filter) so the summary
    // stays stable regardless of which subset the caller is viewing.
    let overdueCount = 0;
    let dueSoonCount = 0;
    let okCount = 0;
    let unknownCount = 0;
    for (const v of views) {
      if (v.status === 'overdue') overdueCount++;
      else if (v.status === 'due_soon') dueSoonCount++;
      else if (v.status === 'ok') okCount++;
      else unknownCount++;
    }

    const filtered =
      statusFilter !== undefined ? views.filter((v) => v.status === statusFilter) : views;

    // Batch-resolve tail numbers for the visible resources. RLS scopes resource
    // to this org. Empty set → skip the query.
    const resourceIds = [...new Set(filtered.map((v) => v.resourceId))];
    const tailByResource = new Map<string, string>();
    if (resourceIds.length > 0) {
      const idList = sql.join(
        resourceIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const tailResult = await tx.execute(sql`
        SELECT id AS "resourceId", tail_number AS "tailNumber"
        FROM resource
        WHERE id = ANY(ARRAY[${idList}])
      `);
      for (const row of extractRows<{ resourceId: string; tailNumber: string | null }>(tailResult)) {
        tailByResource.set(row.resourceId, row.tailNumber ?? '—');
      }
    }

    const rows: MaintenanceReminderReportRow[] = filtered.map((v) => ({
      ...v,
      tailNumber: tailByResource.get(v.resourceId) ?? '—',
    }));

    return { rows, overdueCount, dueSoonCount, okCount, unknownCount };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getMaintenanceRemindersReport(
  session: AppSession | null | undefined,
  input: unknown = {},
): Promise<MaintenanceRemindersReportResult> {
  const db = await getDb();
  return _impl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getMaintenanceRemindersReportWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown = {},
): Promise<MaintenanceRemindersReportResult> {
  return _impl(db, session, input);
}
