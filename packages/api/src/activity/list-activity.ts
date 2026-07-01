/**
 * activity/list-activity.ts — Read-only activity feed (Slice A1.1).
 *
 * Returns a paginated, reverse-chronological list of audit_log entries for the
 * authenticated org, enriched with actor names and curated summaries.
 *
 * AUTHZ: requireCapability(session, 'reporting:access') FIRST.
 * TENANT ISOLATION: org_id from session only; ONE withSessionOrgContextWithDb;
 *   NO org_id predicate in SQL (RLS scopes the read — the choke-point).
 * READ-ONLY: zero writes to audit_log (records integrity preserved).
 * READS NOT AUDITED: reading the audit trail produces no new audit row.
 *
 * KEYSET PAGINATION:
 *   cursor = { createdAt, id } from a prior page's nextCursor.
 *   WHERE clause: (created_at, id) < (cursor.createdAt, cursor.id)
 *   All cursor values are bound params (never interpolated). Stable ordering
 *   because (created_at, id) is a unique sort key (id is a uuid PK).
 *
 * ACTOR NAME RESOLUTION (per spec A1.1):
 *   - actor_user_id IS NULL → "System" (system-generated event)
 *   - LEFT JOIN app_user row present → full_name ?? email
 *   - LEFT JOIN app_user row missing (user hard-deleted) → "A former user"
 *
 * TWO CALLING FORMS:
 *   listActivity(session, opts?)           — app code.
 *   listActivityWithDb(db, session, opts?) — tests (inject pglite client).
 *
 * [VERIFY-A1-CAP]: actor names visible to full reporting:access set (owner/
 *   manager/dispatcher/cfi/accountant). Compliance: expected PASS.
 * [VERIFY-A1-RETENTION]: A1 imposes no new retention obligation. Expected PASS.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import { extractRows } from '../db-rows.js';
import type { AppSession } from '../auth/types.js';
import { summarizeAuditEntry, activityPath } from '@aeroops/core';
import type { ActivityEntry, ActivityCursor, ListActivityResult, ListActivityOptions } from './types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 100;

// ─── Actor name resolution ────────────────────────────────────────────────────

/**
 * resolveActorName — determines the display name for an audit row actor.
 *
 * actorUserId null   → "System" (system-generated event)
 * fullName present   → fullName (may be null from DB join)
 * email present      → email
 * neither            → "A former user" (user hard-deleted; join row gone)
 */
function resolveActorName(
  actorUserId: string | null,
  fullName: string | null | undefined,
  email: string | null | undefined,
): string {
  if (actorUserId === null) return 'System';
  if (fullName) return fullName;
  if (email) return email;
  return 'A former user';
}

// ─── Row shape from SQL ───────────────────────────────────────────────────────

interface AuditActivityRow {
  id: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  createdAt: Date;
  actorFullName: string | null;
  actorEmail: string | null;
}

// ─── Core implementation ──────────────────────────────────────────────────────

async function _listActivityImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts: ListActivityOptions = {},
): Promise<ListActivityResult> {
  // 1. Capability gate — FIRST (before any db call).
  requireCapability(session, 'reporting:access');

  // 2. Normalize pagination options.
  const limit = Math.min(
    opts.limit !== undefined && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  const cursor = opts.cursor;

  // 3. ONE withSessionOrgContextWithDb call — org_id from session only; RLS scopes.
  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // 4. SELECT with LEFT JOIN for actor name.
    //    keyset cursor: when provided, filter (created_at, id) < (cursor values).
    //    All cursor values are bound params — never interpolated.
    //    Fetch limit+1 to detect whether there is a next page.
    let rows: AuditActivityRow[];

    if (cursor) {
      const result = await tx.execute(sql`
        SELECT
          al.id                  AS "id",
          al.actor_user_id       AS "actorUserId",
          al.action              AS "action",
          al.entity_type         AS "entityType",
          al.entity_id           AS "entityId",
          al.metadata            AS "metadata",
          al.created_at          AS "createdAt",
          u.full_name            AS "actorFullName",
          u.email                AS "actorEmail"
        FROM audit_log al
        LEFT JOIN app_user u ON u.id = al.actor_user_id
        WHERE (al.created_at, al.id) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)
        ORDER BY al.created_at DESC, al.id DESC
        LIMIT ${limit + 1}
      `);
      rows = extractRows<AuditActivityRow>(result);
    } else {
      const result = await tx.execute(sql`
        SELECT
          al.id                  AS "id",
          al.actor_user_id       AS "actorUserId",
          al.action              AS "action",
          al.entity_type         AS "entityType",
          al.entity_id           AS "entityId",
          al.metadata            AS "metadata",
          al.created_at          AS "createdAt",
          u.full_name            AS "actorFullName",
          u.email                AS "actorEmail"
        FROM audit_log al
        LEFT JOIN app_user u ON u.id = al.actor_user_id
        ORDER BY al.created_at DESC, al.id DESC
        LIMIT ${limit + 1}
      `);
      rows = extractRows<AuditActivityRow>(result);
    }

    // 5. Detect next page: if we got limit+1 rows, there is more data.
    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

    // 6. Map rows to ActivityEntry via the pure summarizer/path helpers.
    const entries: ActivityEntry[] = pageRows.map((row) => {
      const actorUserId = row.actorUserId ?? null;
      const fullName    = row.actorFullName ?? null;
      const email       = row.actorEmail    ?? null;

      const actorName = resolveActorName(actorUserId, fullName, email);
      const summary   = summarizeAuditEntry({
        action:     row.action,
        entityType: row.entityType,
        metadata:   row.metadata,
      });
      const entityPath = activityPath({
        entityType: row.entityType,
        entityId:   row.entityId ?? null,
        metadata:   row.metadata,
      });

      return {
        id:         row.id,
        actorName,
        summary,
        entityType: row.entityType,
        entityPath,
        createdAt:  row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as string),
      };
    });

    // 7. Build nextCursor from the LAST entry of the page (not the extra row).
    let nextCursor: ActivityCursor | undefined;
    if (hasNextPage && entries.length > 0) {
      const last = entries[entries.length - 1]!;
      nextCursor = { createdAt: last.createdAt, id: last.id };
    }

    return { entries, ...(nextCursor ? { nextCursor } : {}) };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * listActivity — paginated, reverse-chronological activity feed for the
 * authenticated org. Requires reporting:access.
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param opts    - Optional { limit?, cursor? }.
 * @returns ListActivityResult — { entries, nextCursor? }.
 * @throws UnauthenticatedError | ForbiddenError.
 */
export async function listActivity(
  session: AppSession | null | undefined,
  opts: ListActivityOptions = {},
): Promise<ListActivityResult> {
  const db = await getDb();
  return _listActivityImpl(db, session, opts);
}

// ─── Test form (inject db) ────────────────────────────────────────────────────

/**
 * listActivityWithDb — same contract as listActivity but accepts an explicit
 * db argument. Tests MUST use this form to avoid triggering getDb().
 *
 * @param db      - The Drizzle database client (pglite test client or prod).
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param opts    - Optional { limit?, cursor? }.
 * @returns ListActivityResult — { entries, nextCursor? }.
 */
export async function listActivityWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts: ListActivityOptions = {},
): Promise<ListActivityResult> {
  return _listActivityImpl(db, session, opts);
}
