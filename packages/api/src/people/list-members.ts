/**
 * list-members.ts — Member list for the People hub (Slice 6.2).
 *
 * listMembers — returns all org members (membership JOIN app_user) with
 * their tags aggregated via array_agg (set-based, no N+1). Default is
 * active-only; pass includeInactive:true to include inactive members.
 *
 * GUARANTEES:
 *   - requireCapability('people:access') FIRST.
 *   - org_id from session only; RLS backstop.
 *   - Tags aggregated in a single query (no N+1).
 *   - Does NOT modify or replace the existing listOrgMembers
 *     (different gate/purpose: schedule:manage_resources vs people:access).
 *
 * TWO CALLING FORMS:
 *   listMembers(session, opts?)          — app code.
 *   listMembersWithDb(db, session, opts) — tests.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import type { MembershipRole } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type {
  OrgMemberListRow,
  MemberCursor,
  ListMembersPageOptions,
  ListMembersPage,
} from './types.js';
import { extractRows } from '../db-rows.js';

export interface ListMembersOptions {
  /** When true, include inactive members. Default: active-only. */
  includeInactive?: boolean;
}

// ─── Pagination constants (listMembersPage) ────────────────────────────────────

const DEFAULT_MEMBER_PAGE_LIMIT = 100;
const MAX_MEMBER_PAGE_LIMIT     = 500;

/** Raw SQL row shape shared by the unbounded and paginated member reads. */
interface MemberSqlRow {
  userId: string;
  fullName: string | null;
  email: string;
  phone: string | null;
  status: string;
  role: string;
  tags: string[];
  /** COALESCE(full_name, email) — the keyset sort column (paginated read only). */
  sortName?: string;
}

/** Map a raw SQL row to the public OrgMemberListRow. */
function toMemberListRow(r: MemberSqlRow): OrgMemberListRow {
  const tags = Array.isArray(r.tags) ? r.tags : [];
  return {
    userId: r.userId,
    displayName: r.fullName ?? r.email,
    email: r.email,
    phone: r.phone,
    status: r.status,
    role: r.role as MembershipRole,
    tags,
    tagCount: tags.length,
  };
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _listMembersImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListMembersOptions,
): Promise<OrgMemberListRow[]> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'people:access');

  const includeInactive = opts?.includeInactive ?? false;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Set-based tag aggregation — single query, no N+1.
    // array_agg with ORDER BY tag returns tags sorted alphabetically.
    // COALESCE(array_agg(...) FILTER (WHERE ...), '{}') handles members with no tags.
    const result = await tx.execute(sql`
      SELECT
        m.user_id          AS "userId",
        u.full_name        AS "fullName",
        u.email,
        u.phone,
        u.status,
        m.role,
        COALESCE(
          array_agg(mt.tag ORDER BY mt.tag) FILTER (WHERE mt.tag IS NOT NULL),
          '{}'::text[]
        )                  AS tags
      FROM membership m
      JOIN app_user u ON u.id = m.user_id
      LEFT JOIN member_tag mt ON mt.user_id = m.user_id
      WHERE (${includeInactive} OR u.status = 'active')
      GROUP BY m.user_id, u.full_name, u.email, u.phone, u.status, m.role
      ORDER BY u.full_name ASC NULLS LAST, u.email ASC
    `);

    const rows = extractRows<MemberSqlRow>(result);
    return rows.map(toMemberListRow);
  });
}

// ─── Paginated implementation (listMembersPage) ────────────────────────────────

/**
 * _listMembersPageImpl — keyset-paginated member roster.
 *
 * Mirrors the activity feed keyset pattern (fetch limit+1 to detect a next
 * page; cursor values are bound params, never interpolated). Ordering is
 * ascending on (COALESCE(full_name, email), user_id) — a strict total order,
 * so paging is deterministic and gap-free even when full_name is null.
 *
 * SEPARATE surface from listMembers: this bounds the read for large rosters;
 * the array-returning listMembers stays unbounded for pickers/mobile/reporting.
 */
async function _listMembersPageImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListMembersPageOptions,
): Promise<ListMembersPage> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'people:access');

  const includeInactive = opts?.includeInactive ?? false;
  const limit = Math.min(
    opts?.limit !== undefined && opts.limit > 0 ? opts.limit : DEFAULT_MEMBER_PAGE_LIMIT,
    MAX_MEMBER_PAGE_LIMIT,
  );
  const cursor = opts?.cursor;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Keyset filter on the group-by columns (COALESCE(full_name,email), user_id).
    // Row-value comparison gives correct strict-greater-than semantics on the
    // composite ascending key. Cursor values are bound params (injection-safe).
    const cursorClause = cursor
      ? sql`AND (COALESCE(u.full_name, u.email), m.user_id) > (${cursor.sortName}, ${cursor.id}::uuid)`
      : sql``;

    const result = await tx.execute(sql`
      SELECT
        m.user_id                       AS "userId",
        u.full_name                     AS "fullName",
        u.email,
        u.phone,
        u.status,
        m.role,
        COALESCE(u.full_name, u.email)  AS "sortName",
        COALESCE(
          array_agg(mt.tag ORDER BY mt.tag) FILTER (WHERE mt.tag IS NOT NULL),
          '{}'::text[]
        )                               AS tags
      FROM membership m
      JOIN app_user u ON u.id = m.user_id
      LEFT JOIN member_tag mt ON mt.user_id = m.user_id
      WHERE (${includeInactive} OR u.status = 'active')
      ${cursorClause}
      GROUP BY m.user_id, u.full_name, u.email, u.phone, u.status, m.role
      ORDER BY COALESCE(u.full_name, u.email) ASC, m.user_id ASC
      LIMIT ${limit + 1}
    `);

    const raw = extractRows<MemberSqlRow>(result);

    // Detect next page: limit+1 rows means more data exists.
    const hasNextPage = raw.length > limit;
    const pageRaw = hasNextPage ? raw.slice(0, limit) : raw;
    const rows = pageRaw.map(toMemberListRow);

    let nextCursor: MemberCursor | undefined;
    if (hasNextPage && pageRaw.length > 0) {
      const last = pageRaw[pageRaw.length - 1]!;
      nextCursor = { sortName: last.sortName ?? last.email, id: last.userId };
    }

    return { rows, ...(nextCursor ? { nextCursor } : {}) };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function listMembers(
  session: AppSession | null | undefined,
  opts?: ListMembersOptions,
): Promise<OrgMemberListRow[]> {
  const db = await getDb();
  return _listMembersImpl(db, session, opts);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function listMembersWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListMembersOptions,
): Promise<OrgMemberListRow[]> {
  return _listMembersImpl(db, session, opts);
}

// ─── Paginated form (app-code) ─────────────────────────────────────────────────

/**
 * listMembersPage — keyset-paginated member roster for large-org list UIs.
 * Backward-compatible ADDITION: listMembers is unchanged.
 */
export async function listMembersPage(
  session: AppSession | null | undefined,
  opts?: ListMembersPageOptions,
): Promise<ListMembersPage> {
  const db = await getDb();
  return _listMembersPageImpl(db, session, opts);
}

// ─── Paginated form (test/injectable) ──────────────────────────────────────────

export async function listMembersPageWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListMembersPageOptions,
): Promise<ListMembersPage> {
  return _listMembersPageImpl(db, session, opts);
}
