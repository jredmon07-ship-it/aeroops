/**
 * list-aircraft.ts — Fleet list read (Slice 5.2).
 *
 * listAircraft — returns all aircraft in the session org (RLS-scoped),
 * with current grounding status and open-squawk count per aircraft.
 * Default: active only. Optional: include inactive.
 *
 * GUARANTEES:
 *   - requireCapability('fleet:access') FIRST — before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - No N+1: grounding probe = one DISTINCT ON query; squawk counts = one
 *     GROUP BY query; aircraft list = one Drizzle select.
 *   - Never crosses org boundaries.
 *
 * TWO CALLING FORMS:
 *   listAircraft(session, opts?)          — app code.
 *   listAircraftWithDb(db, session, opts) — tests; inject pglite client.
 */
import { eq, and, sql } from 'drizzle-orm';
import { resource } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { loadGroundingProbe } from '../maintenance/internal.js';
import type { AircraftListRow } from './types.js';

// ─── Options ──────────────────────────────────────────────────────────────────

export interface ListAircraftOptions {
  /** When true, include both active and inactive aircraft. Default: false. */
  includeInactive?: boolean;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _listAircraftImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListAircraftOptions,
): Promise<AircraftListRow[]> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'fleet:access');

  const includeInactive = opts?.includeInactive ?? false;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // 2. Fetch aircraft (RLS-scoped).
    const whereConditions = includeInactive
      ? eq(resource.kind, 'aircraft')
      : and(eq(resource.kind, 'aircraft'), eq(resource.active, true));

    const rows = await tx
      .select({
        id: resource.id,
        tailNumber: resource.tailNumber,
        make: resource.make,
        model: resource.model,
        active: resource.active,
      })
      .from(resource)
      .where(whereConditions)
      .orderBy(resource.tailNumber, resource.displayName);

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);

    // 3. Grounding probe — one query for all aircraft.
    const groundingMap = await loadGroundingProbe(tx, ids);

    // 4. Open-squawk counts — one GROUP BY query.
    const idList = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const squawkResult = await tx.execute(sql`
      SELECT
        resource_id AS "resourceId",
        COUNT(*)::int AS "count"
      FROM squawk
      WHERE status = 'open'
        AND resource_id = ANY(ARRAY[${idList}])
      GROUP BY resource_id
    `);
    const squawkRows = (squawkResult.rows ?? squawkResult) as Array<{
      resourceId: string;
      count: number | string;
    }>;
    const squawkMap = new Map<string, number>();
    for (const id of ids) squawkMap.set(id, 0);
    for (const row of squawkRows) {
      squawkMap.set(
        row.resourceId,
        typeof row.count === 'string' ? parseInt(row.count, 10) : row.count,
      );
    }

    // 5. Assemble.
    return rows.map((r) => {
      const grounding = groundingMap.get(r.id);
      return {
        id: r.id,
        tailNumber: r.tailNumber ?? '',
        make: r.make ?? null,
        model: r.model ?? null,
        active: r.active,
        grounded: grounding?.grounded ?? false,
        openSquawkCount: squawkMap.get(r.id) ?? 0,
      };
    });
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function listAircraft(
  session: AppSession | null | undefined,
  opts?: ListAircraftOptions,
): Promise<AircraftListRow[]> {
  const db = await getDb();
  return _listAircraftImpl(db, session, opts);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function listAircraftWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListAircraftOptions,
): Promise<AircraftListRow[]> {
  return _listAircraftImpl(db, session, opts);
}
