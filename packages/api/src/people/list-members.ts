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
import type { OrgMemberListRow } from './types.js';
import { extractRows } from '../db-rows.js';

export interface ListMembersOptions {
  /** When true, include inactive members. Default: active-only. */
  includeInactive?: boolean;
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

    const rows = extractRows<{
      userId: string;
      fullName: string | null;
      email: string;
      phone: string | null;
      status: string;
      role: string;
      tags: string[];
    }>(result);

    return rows.map((r) => {
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
    });
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
