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
import type {
  AircraftListRow,
  AircraftCursor,
  ListAircraftPageOptions,
  ListAircraftPage,
} from './types.js';
import { extractRows } from '../db-rows.js';

// ─── Options ──────────────────────────────────────────────────────────────────

export interface ListAircraftOptions {
  /** When true, include both active and inactive aircraft. Default: false. */
  includeInactive?: boolean;
}

// ─── Pagination constants (listAircraftPage) ───────────────────────────────────

const DEFAULT_AIRCRAFT_PAGE_LIMIT = 100;
const MAX_AIRCRAFT_PAGE_LIMIT     = 500;

/** Base aircraft row before grounding/squawk/work-order enrichment. */
interface AircraftBaseRow {
  id: string;
  tailNumber: string | null;
  make: string | null;
  model: string | null;
  active: boolean;
}

/**
 * enrichAircraftRows — attach grounding status + open-squawk + open-work-order
 * counts to a set of base aircraft rows. Set-based (no N+1): one grounding
 * probe, one squawk GROUP BY, one work-order GROUP BY, regardless of page size.
 * Shared by the unbounded (listAircraft) and paginated (listAircraftPage) reads.
 */
async function enrichAircraftRows(
  tx: AnyDb,
  rows: AircraftBaseRow[],
): Promise<AircraftListRow[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);

  // Grounding probe — one query for all aircraft.
  const groundingMap = await loadGroundingProbe(tx, ids);

  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  // Open-squawk counts — one GROUP BY query.
  const squawkResult = await tx.execute(sql`
    SELECT
      resource_id AS "resourceId",
      COUNT(*)::int AS "count"
    FROM squawk
    WHERE status = 'open'
      AND resource_id = ANY(ARRAY[${idList}])
    GROUP BY resource_id
  `);
  const squawkRows = extractRows<{ resourceId: string; count: number | string }>(squawkResult);
  const squawkMap = new Map<string, number>();
  for (const id of ids) squawkMap.set(id, 0);
  for (const row of squawkRows) {
    squawkMap.set(
      row.resourceId,
      typeof row.count === 'string' ? parseInt(row.count, 10) : row.count,
    );
  }

  // Open work-order counts — one GROUP BY query (status IN open/in_progress).
  const woResult = await tx.execute(sql`
    SELECT
      resource_id AS "resourceId",
      COUNT(*)::int AS "count"
    FROM work_order
    WHERE status IN ('open', 'in_progress')
      AND resource_id = ANY(ARRAY[${idList}])
    GROUP BY resource_id
  `);
  const woRows = extractRows<{ resourceId: string; count: number | string }>(woResult);
  const woMap = new Map<string, number>();
  for (const id of ids) woMap.set(id, 0);
  for (const row of woRows) {
    woMap.set(
      row.resourceId,
      typeof row.count === 'string' ? parseInt(row.count, 10) : row.count,
    );
  }

  return rows.map((r) => {
    const grounding = groundingMap.get(r.id);
    return {
      id: r.id,
      tailNumber: r.tailNumber ?? '',
      make: r.make ?? null,
      model: r.model ?? null,
      active: r.active,
      grounded: grounding?.grounded ?? false,
      groundingReason: grounding?.reason ?? null,
      openSquawkCount: squawkMap.get(r.id) ?? 0,
      openWorkOrderCount: woMap.get(r.id) ?? 0,
    };
  });
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

    // 3. Enrich with grounding + squawk + work-order counts (set-based, no N+1).
    return enrichAircraftRows(tx, rows);
  });
}

// ─── Paginated implementation (listAircraftPage) ───────────────────────────────

/**
 * _listAircraftPageImpl — keyset-paginated fleet list.
 *
 * Mirrors the activity feed keyset pattern (fetch limit+1 to detect a next
 * page; cursor values are bound params, never interpolated). Ordering is
 * ascending on (COALESCE(tail_number, ''), id) — a strict total order, so
 * paging is deterministic and gap-free. Enrichment reuses enrichAircraftRows
 * so per-page counts stay set-based (no N+1) regardless of page size.
 */
async function _listAircraftPageImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListAircraftPageOptions,
): Promise<ListAircraftPage> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'fleet:access');

  const includeInactive = opts?.includeInactive ?? false;
  const limit = Math.min(
    opts?.limit !== undefined && opts.limit > 0 ? opts.limit : DEFAULT_AIRCRAFT_PAGE_LIMIT,
    MAX_AIRCRAFT_PAGE_LIMIT,
  );
  const cursor = opts?.cursor;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Keyset filter on (COALESCE(tail_number,''), id) — strict-greater-than on
    // the composite ascending key. Cursor values are bound params (injection-safe).
    const activeClause = includeInactive ? sql`` : sql`AND r.active = true`;
    const cursorClause = cursor
      ? sql`AND (COALESCE(r.tail_number, ''), r.id) > (${cursor.tailNumber}, ${cursor.id}::uuid)`
      : sql``;

    const result = await tx.execute(sql`
      SELECT
        r.id                          AS "id",
        r.tail_number                 AS "tailNumber",
        r.make                        AS "make",
        r.model                       AS "model",
        r.active                      AS "active"
      FROM resource r
      WHERE r.kind = 'aircraft'
      ${activeClause}
      ${cursorClause}
      ORDER BY COALESCE(r.tail_number, '') ASC, r.id ASC
      LIMIT ${limit + 1}
    `);

    const base = extractRows<AircraftBaseRow>(result);

    // Detect next page: limit+1 rows means more data exists.
    const hasNextPage = base.length > limit;
    const pageBase = hasNextPage ? base.slice(0, limit) : base;

    const rows = await enrichAircraftRows(tx, pageBase);

    let nextCursor: AircraftCursor | undefined;
    if (hasNextPage && pageBase.length > 0) {
      const last = pageBase[pageBase.length - 1]!;
      nextCursor = { tailNumber: last.tailNumber ?? '', id: last.id };
    }

    return { rows, ...(nextCursor ? { nextCursor } : {}) };
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

// ─── Paginated form (app-code) ─────────────────────────────────────────────────

/**
 * listAircraftPage — keyset-paginated fleet list for large-fleet list UIs.
 * Backward-compatible ADDITION: listAircraft is unchanged.
 */
export async function listAircraftPage(
  session: AppSession | null | undefined,
  opts?: ListAircraftPageOptions,
): Promise<ListAircraftPage> {
  const db = await getDb();
  return _listAircraftPageImpl(db, session, opts);
}

// ─── Paginated form (test/injectable) ──────────────────────────────────────────

export async function listAircraftPageWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListAircraftPageOptions,
): Promise<ListAircraftPage> {
  return _listAircraftPageImpl(db, session, opts);
}
