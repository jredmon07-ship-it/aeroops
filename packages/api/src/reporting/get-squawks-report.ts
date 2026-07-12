/**
 * reporting/get-squawks-report.ts — getSquawksReport (FC canned-report menu).
 *
 * Org-wide squawk list for the Operational Reports page, with an optional
 * status filter. Reuses the list-squawks DATA SHAPE (SquawkView) but under
 * reporting:access (not maintenance:access), and enriches each row with the
 * aircraft tail number so an org-wide report is readable. READ-ONLY over
 * EXISTING tables (squawk, resource) — NO new migration.
 *
 * ── Why a distinct read (not listSquawks) ────────────────────────────────────
 * listSquawks requires maintenance:access; this report is exposed to the
 * broader reporting:access audience (owner/manager/dispatcher/cfi/accountant),
 * consistent with the existing maintenance-trend section on the same page. The
 * authz gate is the only meaningful difference, so this is a thin sibling read
 * rather than a call into listSquawks (which would double-gate on the wrong cap).
 *
 * AUTHZ: requireCapability('reporting:access') FIRST.
 * TENANT ISOLATION: org_id from session only (withSessionOrgContextWithDb);
 *   squawk + resource are RLS-scoped by the GUC — no org_id predicate needed.
 * READ-ONLY: zero writes, zero audit rows.
 *
 * [VERIFY-M1-A] Squawks are operator DATA — NOT a Part-43/airworthiness/RTS
 *   determination.
 *
 * TWO CALLING FORMS:
 *   getSquawksReport(session, input)          — app code.
 *   getSquawksReportWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { SQUAWK_STATUSES } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toSquawkView } from '../maintenance/internal.js';
import type { SquawkView } from '../maintenance/types.js';
import { extractRows } from '../db-rows.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const InputSchema = z.object({
  status: z.enum(SQUAWK_STATUSES).optional(),
});

export type GetSquawksReportInput = z.infer<typeof InputSchema>;

// ─── Output types ─────────────────────────────────────────────────────────────

export interface SquawkReportRow extends SquawkView {
  /** Aircraft tail number ('—' when the resource has none recorded). */
  tailNumber: string;
}

export interface SquawksReportResult {
  rows: SquawkReportRow[];
  openCount: number;
  deferredCount: number;
  resolvedCount: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SquawksReportResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'reporting:access');

  // 2. VALIDATE.
  const parsed = InputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[reporting] invalid getSquawksReport input: ${first?.message ?? 'unknown'}`);
  }
  const { status } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const statusClause = status !== undefined ? sql`WHERE s.status = ${status}::squawk_status` : sql``;

    // squawk LEFT JOIN resource (tail number). RLS scopes both to this org —
    // no org_id predicate needed. Newest-first, mirroring listSquawks.
    const result = await tx.execute(sql`
      SELECT
        s.id                 AS "id",
        s.resource_id        AS "resourceId",
        s.dispatch_ticket_id AS "dispatchTicketId",
        s.title              AS "title",
        s.description        AS "description",
        s.severity           AS "severity",
        s.status             AS "status",
        s.reported_by        AS "reportedBy",
        s.reported_at        AS "reportedAt",
        s.resolution_notes   AS "resolutionNotes",
        s.resolved_by        AS "resolvedBy",
        s.resolved_at        AS "resolvedAt",
        r.tail_number        AS "tailNumber"
      FROM squawk s
      LEFT JOIN resource r ON r.id = s.resource_id
      ${statusClause}
      ORDER BY s.reported_at DESC
    `);

    const rows = extractRows<{
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
      tailNumber: string | null;
    }>(result);

    let openCount = 0;
    let deferredCount = 0;
    let resolvedCount = 0;
    const reportRows: SquawkReportRow[] = rows.map((row) => {
      const view = toSquawkView(row);
      if (view.status === 'open') openCount++;
      else if (view.status === 'deferred') deferredCount++;
      else if (view.status === 'resolved') resolvedCount++;
      return { ...view, tailNumber: row.tailNumber ?? '—' };
    });

    return { rows: reportRows, openCount, deferredCount, resolvedCount };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getSquawksReport(
  session: AppSession | null | undefined,
  input: unknown = {},
): Promise<SquawksReportResult> {
  const db = await getDb();
  return _impl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getSquawksReportWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown = {},
): Promise<SquawksReportResult> {
  return _impl(db, session, input);
}
