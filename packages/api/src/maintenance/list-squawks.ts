/**
 * list-squawks.ts — listSquawks and getOpenSquawkCounts read paths.
 * (DISPATCH-3b, ADR-0008 §2.4)
 *
 * listSquawks — authz maintenance:access; newest-first; optional resourceId +
 *   status filters; limit capped at 200.
 *
 * getOpenSquawkCounts — authz maintenance:access; GROUP BY resource_id WHERE
 *   status='open' AND resource_id = ANY(...); returns Map<resourceId, number>
 *   with 0 default for every requested id.
 *
 * GUARANTEES (both):
 *   - requireCapability FIRST — before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - No N+1: both use a single parameterised query.
 *
 * TWO CALLING FORMS per function (app + WithDb).
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
import { toSquawkView } from './report-squawk.js';
import type { SquawkView } from './types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── listSquawks input schema ─────────────────────────────────────────────────

const listSquawksInputSchema = z.object({
  resourceId: z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }).optional(),
  status:     z.enum(SQUAWK_STATUSES).optional(),
  limit:      z.number().int().positive().max(200).optional(),
});

export type ListSquawksInput = z.infer<typeof listSquawksInputSchema>;

// ─── listSquawks implementation ───────────────────────────────────────────────

async function _listSquawksImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SquawkView[]> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'maintenance:access');

  // 2. VALIDATE.
  const parsed = listSquawksInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid listSquawks input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceId, status, limit = 200 } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Build WHERE clause fragments.
    const conditions: ReturnType<typeof sql>[] = [];
    if (resourceId !== undefined) {
      conditions.push(sql`resource_id = ${resourceId}::uuid`);
    }
    if (status !== undefined) {
      conditions.push(sql`status = ${status}::squawk_status`);
    }

    const whereClause = conditions.length > 0
      ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
      : sql``;

    const result = await tx.execute(sql`
      SELECT
        id,
        resource_id        AS "resourceId",
        dispatch_ticket_id AS "dispatchTicketId",
        title,
        description,
        severity,
        status,
        reported_by        AS "reportedBy",
        reported_at        AS "reportedAt",
        resolution_notes   AS "resolutionNotes",
        resolved_by        AS "resolvedBy",
        resolved_at        AS "resolvedAt"
      FROM squawk
      ${whereClause}
      ORDER BY reported_at DESC
      LIMIT ${limit}
    `);

    const rows = (result.rows ?? result) as Array<{
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
    }>;

    return rows.map(toSquawkView);
  });
}

// App form
export async function listSquawks(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SquawkView[]> {
  const db = await getDb();
  return _listSquawksImpl(db, session, input);
}

// Test/injectable form
export async function listSquawksWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SquawkView[]> {
  return _listSquawksImpl(db, session, input);
}

// ─── getOpenSquawkCounts input schema ────────────────────────────────────────

const getOpenSquawkCountsInputSchema = z.object({
  resourceIds: z
    .array(z.string().regex(UUID_RE, { message: 'resourceIds must be UUIDs' }))
    .min(1, { message: 'At least one resourceId is required' }),
});

export type GetOpenSquawkCountsInput = z.infer<typeof getOpenSquawkCountsInputSchema>;

// ─── getOpenSquawkCounts implementation ──────────────────────────────────────

async function _getOpenSquawkCountsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<Map<string, number>> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'maintenance:access');

  // 2. VALIDATE.
  const parsed = getOpenSquawkCountsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid getOpenSquawkCounts input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceIds } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Initialise all ids to 0 as the default.
    const result = new Map<string, number>();
    for (const id of resourceIds) {
      result.set(id, 0);
    }

    // Build parameterised uuid[] for ANY(ARRAY[...]).
    const idList = sql.join(
      resourceIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );

    const queryResult = await tx.execute(sql`
      SELECT
        resource_id AS "resourceId",
        COUNT(*)::int AS "count"
      FROM squawk
      WHERE status = 'open'
        AND resource_id = ANY(ARRAY[${idList}])
      GROUP BY resource_id
    `);

    const rows = (queryResult.rows ?? queryResult) as Array<{
      resourceId: string;
      count: number | string;
    }>;

    for (const row of rows) {
      result.set(row.resourceId, typeof row.count === 'string' ? parseInt(row.count, 10) : row.count);
    }

    return result;
  });
}

// App form
export async function getOpenSquawkCounts(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<Map<string, number>> {
  const db = await getDb();
  return _getOpenSquawkCountsImpl(db, session, input);
}

// Test/injectable form
export async function getOpenSquawkCountsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<Map<string, number>> {
  return _getOpenSquawkCountsImpl(db, session, input);
}
