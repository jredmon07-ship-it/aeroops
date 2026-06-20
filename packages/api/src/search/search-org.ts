/**
 * search-org.ts — Global org search (Slice S1.1).
 *
 * searchOrg(session, { query })          — app code form.
 * searchOrgWithDb(db, session, { query }) — test/injectable form.
 *
 * ALGORITHM (per spec S1.1):
 *   1. requireCapability(session, 'app:access') — front door.
 *      null/incomplete session → UnauthenticatedError.
 *   2. Zod validation: { query: z.string().max(200) }.
 *      q = parsed.query.trim().
 *      If q.length < 2 → return { groups: [] } with NO db call.
 *   3. Build bound params:
 *        pattern = '%' + escapeLike(q) + '%'   (any-position match)
 *        prefix  = escapeLike(q) + '%'         (starts-with match)
 *      NEVER interpolate the query into SQL text.
 *   4. ONE withSessionOrgContextWithDb call (org_id from session only; RLS scopes).
 *   5. For EACH of the 6 entity types:
 *        if hasCapability(session, <cap>) → run bounded SQL query (LIMIT 5)
 *        else → skip entirely (no query run — this is THE no-leak guarantee).
 *      Sequential, deterministic.
 *   6. Map rows to SearchResult { id, primary (never empty), secondary|null, path }.
 *   7. Assemble groups in FIXED order (aircraft, member, work_order, squawk,
 *      course, reservation). Omit empty groups. Return { groups }.
 *
 * RANKING (within each group):
 *   ORDER BY (CASE WHEN <field> ILIKE ${prefix} ESCAPE '\' THEN 0 ELSE 1 END),
 *            lower(<primary_field>) ASC
 *   (prefix-match first, then case-insensitive alphabetical — deterministic).
 *
 * SECURITY INVARIANTS:
 *   - Per-type hasCapability gate is THE security boundary for result leakage.
 *   - All query values are bound params (injection guard).
 *   - escapeLike handles LIKE-semantics (wildcard suppression) separately.
 *   - org_id comes from the session only; RLS is the backstop.
 *   - Reads are NOT audited.
 *   - NO money, NO computed FAA determination.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { escapeLike } from '@aeroops/core';
import { requireCapability, hasCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';

import {
  SEARCH_RESULT_TYPE_LABELS,
  SEARCH_RESULT_TYPE_ORDER,
} from './types.js';
import type {
  SearchResult,
  SearchGroup,
  SearchOrgInput,
  SearchOrgResult,
} from './types.js';

// ─── Zod schema ───────────────────────────────────────────────────────────────

const searchOrgInputSchema = z.object({
  query: z.string().max(200),
});

// ─── LIKE ESCAPE character ───────────────────────────────────────────────────
//
// PostgreSQL LIKE/ILIKE syntax: ... ILIKE pattern ESCAPE escapeChar
//
// We use backslash as the LIKE escape character (consistent with escapeLike helper).
// In JavaScript template literals, '\\' in source → single '\' in the actual string
// → the SQL string ESCAPE '\' is sent to PostgreSQL.
//
// This is for LIKE-semantics only (suppresses wildcards in the pattern).
// SQL injection safety is handled separately by bound parameters.
const LIKE_ESCAPE = sql.raw(`ESCAPE '\\'`);

// ─── Shared implementation ────────────────────────────────────────────────────

async function _searchOrgImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SearchOrgResult> {
  // 1. AUTHZ FRONT DOOR (UnauthenticatedError if session is null/incomplete).
  requireCapability(session, 'app:access');

  // 2. VALIDATE input.
  const parsed = searchOrgInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    // max(200) is the only constraint; treat as empty result (not a caller error).
    return { groups: [] };
  }
  const q = parsed.data.query.trim();

  // 3. SHORT-CIRCUIT: query too short → no db call.
  if (q.length < 2) {
    return { groups: [] };
  }

  // 4. Build bound-param values.
  //    escapeLike() escapes LIKE metacharacters (\, %, _) — NEVER interpolated into SQL text.
  const pattern = '%' + escapeLike(q) + '%';
  const prefix  = escapeLike(q) + '%';

  // 5. Run per-type queries inside one session org context.
  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const groupMap = new Map<string, SearchResult[]>();

    // ── 5a. Aircraft (fleet:access) ─────────────────────────────────────────
    if (hasCapability(session, 'fleet:access')) {
      const result = await tx.execute(sql`
        SELECT
          id,
          tail_number    AS "tailNumber",
          display_name   AS "displayName",
          make,
          model
        FROM resource
        WHERE kind = 'aircraft'
          AND active = true
          AND (
            tail_number  ILIKE ${pattern} ${LIKE_ESCAPE}
            OR make      ILIKE ${pattern} ${LIKE_ESCAPE}
            OR model     ILIKE ${pattern} ${LIKE_ESCAPE}
          )
        ORDER BY
          (CASE WHEN tail_number  ILIKE ${prefix} ${LIKE_ESCAPE} THEN 0
                WHEN display_name ILIKE ${prefix} ${LIKE_ESCAPE} THEN 0
                ELSE 1 END),
          lower(COALESCE(tail_number, display_name, '')) ASC
        LIMIT 5
      `);
      const rows = (result.rows ?? result) as Array<{
        id: string;
        tailNumber: string | null;
        displayName: string | null;
        make: string | null;
        model: string | null;
      }>;
      const aircraftResults: SearchResult[] = rows.map((r) => {
        const primaryField = r.tailNumber ?? r.displayName ?? '';
        const makeModel = [r.make, r.model].filter(Boolean).join(' ') || null;
        return {
          id: r.id,
          primary: primaryField,
          secondary: makeModel,
          path: `/fleet/${r.id}`,
        };
      });
      if (aircraftResults.length > 0) {
        groupMap.set('aircraft', aircraftResults);
      }
    }

    // ── 5b. Members (people:access) ──────────────────────────────────────────
    if (hasCapability(session, 'people:access')) {
      const result = await tx.execute(sql`
        SELECT
          u.id         AS "userId",
          u.full_name  AS "fullName",
          u.email
        FROM app_user u
        JOIN membership m ON m.user_id = u.id
        WHERE u.status = 'active'
          AND (
            u.full_name ILIKE ${pattern} ${LIKE_ESCAPE}
            OR u.email   ILIKE ${pattern} ${LIKE_ESCAPE}
          )
        ORDER BY
          (CASE WHEN COALESCE(u.full_name, u.email) ILIKE ${prefix} ${LIKE_ESCAPE} THEN 0 ELSE 1 END),
          lower(COALESCE(u.full_name, u.email)) ASC
        LIMIT 5
      `);
      const rows = (result.rows ?? result) as Array<{
        userId: string;
        fullName: string | null;
        email: string;
      }>;
      const memberResults: SearchResult[] = rows.map((r) => {
        const primary = r.fullName ?? r.email;
        const secondary = r.fullName ? r.email : null;
        return {
          id: r.userId,
          primary,
          secondary,
          path: `/people/${r.userId}`,
        };
      });
      if (memberResults.length > 0) {
        groupMap.set('member', memberResults);
      }
    }

    // ── 5c. Work orders (maintenance:access) ────────────────────────────────
    if (hasCapability(session, 'maintenance:access')) {
      const result = await tx.execute(sql`
        SELECT
          id,
          title,
          status
        FROM work_order
        WHERE title ILIKE ${pattern} ${LIKE_ESCAPE}
        ORDER BY
          (CASE WHEN title ILIKE ${prefix} ${LIKE_ESCAPE} THEN 0 ELSE 1 END),
          lower(title) ASC
        LIMIT 5
      `);
      const rows = (result.rows ?? result) as Array<{
        id: string;
        title: string;
        status: string;
      }>;
      const woResults: SearchResult[] = rows.map((r) => ({
        id: r.id,
        primary: r.title,
        secondary: r.status,
        path: `/maintenance/work-orders/${r.id}`,
      }));
      if (woResults.length > 0) {
        groupMap.set('work_order', woResults);
      }
    }

    // ── 5d. Squawks (maintenance:access) ────────────────────────────────────
    if (hasCapability(session, 'maintenance:access')) {
      const result = await tx.execute(sql`
        SELECT
          id,
          title,
          severity,
          status
        FROM squawk
        WHERE title ILIKE ${pattern} ${LIKE_ESCAPE}
        ORDER BY
          (CASE WHEN title ILIKE ${prefix} ${LIKE_ESCAPE} THEN 0 ELSE 1 END),
          lower(title) ASC
        LIMIT 5
      `);
      const rows = (result.rows ?? result) as Array<{
        id: string;
        title: string;
        severity: string;
        status: string;
      }>;
      const squawkResults: SearchResult[] = rows.map((r) => ({
        id: r.id,
        primary: r.title,
        secondary: `${r.severity} · ${r.status}`,
        path: `/maintenance/squawks`,
      }));
      if (squawkResults.length > 0) {
        groupMap.set('squawk', squawkResults);
      }
    }

    // ── 5e. Courses (training:access) ────────────────────────────────────────
    if (hasCapability(session, 'training:access')) {
      const result = await tx.execute(sql`
        SELECT
          id,
          title,
          status
        FROM course
        WHERE title ILIKE ${pattern} ${LIKE_ESCAPE}
        ORDER BY
          (CASE WHEN title ILIKE ${prefix} ${LIKE_ESCAPE} THEN 0 ELSE 1 END),
          lower(title) ASC
        LIMIT 5
      `);
      const rows = (result.rows ?? result) as Array<{
        id: string;
        title: string;
        status: string;
      }>;
      const courseResults: SearchResult[] = rows.map((r) => ({
        id: r.id,
        primary: r.title,
        secondary: r.status,
        path: `/training/${r.id}`,
      }));
      if (courseResults.length > 0) {
        groupMap.set('course', courseResults);
      }
    }

    // ── 5f. Reservations (schedule:access, status != 'cancelled') ────────────
    if (hasCapability(session, 'schedule:access')) {
      const result = await tx.execute(sql`
        SELECT
          id,
          start_at  AS "startAt",
          notes
        FROM reservation
        WHERE status != 'cancelled'
          AND notes ILIKE ${pattern} ${LIKE_ESCAPE}
        ORDER BY
          (CASE WHEN notes ILIKE ${prefix} ${LIKE_ESCAPE} THEN 0 ELSE 1 END),
          start_at ASC
        LIMIT 5
      `);
      const rows = (result.rows ?? result) as Array<{
        id: string;
        startAt: Date | string;
        notes: string | null;
      }>;
      const reservationResults: SearchResult[] = rows.map((r) => {
        const startDate = r.startAt instanceof Date ? r.startAt : new Date(r.startAt as string);
        // Format: "Jan 10, 2027 08:00 UTC" — unambiguous, human-readable.
        const datePart = new Intl.DateTimeFormat('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        }).format(startDate);
        const timePart = new Intl.DateTimeFormat('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: 'UTC',
        }).format(startDate);
        const primary = `${datePart} ${timePart} UTC`;
        const notes = r.notes ?? '';
        const secondary = notes.length > 60 ? notes.slice(0, 60) + '…' : (notes || null);
        return {
          id: r.id,
          primary,
          secondary,
          path: `/schedule/board`,
        };
      });
      if (reservationResults.length > 0) {
        groupMap.set('reservation', reservationResults);
      }
    }

    // 6. Assemble groups in FIXED type order; omit empty groups.
    const groups: SearchGroup[] = [];
    for (const type of SEARCH_RESULT_TYPE_ORDER) {
      const results = groupMap.get(type);
      if (results && results.length > 0) {
        groups.push({
          type,
          label: SEARCH_RESULT_TYPE_LABELS[type],
          results,
        });
      }
    }

    return { groups };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function searchOrg(
  session: AppSession | null | undefined,
  input: SearchOrgInput,
): Promise<SearchOrgResult> {
  const db = await getDb();
  return _searchOrgImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function searchOrgWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: SearchOrgInput,
): Promise<SearchOrgResult> {
  return _searchOrgImpl(db, session, input);
}
