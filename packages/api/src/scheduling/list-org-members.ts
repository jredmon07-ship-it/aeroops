/**
 * list-org-members.ts — Org member read surface (SCHED-1).
 *
 * Returns members of the session org joined with their app_user profile,
 * optionally filtered by role. Backs the instructor picker in the Add-Resource
 * dialog on the resource-admin panel.
 *
 * GUARANTEES:
 *   - authz: requireCapability('schedule:manage_resources') — resource-admin
 *     gate; only owner / manager / dispatcher may call this.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Never crosses org boundaries.
 *
 * NOTE on displayName: app_user has no dedicated display_name column in Slice 1.
 *   We use full_name (appUser.fullName) and fall back to email when full_name is
 *   null. Callers should surface whichever non-null value is returned.
 *
 * TWO CALLING FORMS:
 *   listOrgMembers(session, opts?)          — app code; uses getDb() internally.
 *   listOrgMembersWithDb(db, session, opts) — tests; inject pglite client.
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { membership, appUser } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import type { MembershipRole } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';

// ─── Exported input / result types ───────────────────────────────────────────

export interface ListOrgMembersOptions {
  /**
   * role — when provided, only return members whose membership.role is in
   * this array. When omitted, all org members are returned.
   */
  role?: MembershipRole[];
}

/** Member row shape returned by listOrgMembers. */
export interface OrgMemberRow {
  /** UUID from membership.userId (= appUser.id). */
  userId: string;
  /**
   * Display name: appUser.fullName (full_name column) when present,
   * otherwise appUser.email (fallback — full_name is nullable in Slice 1).
   */
  displayName: string;
  email: string;
  role: MembershipRole;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _listOrgMembersImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListOrgMembersOptions,
): Promise<OrgMemberRow[]> {
  // AUTHZ FIRST — before any data access.
  requireCapability(session, 'schedule:manage_resources');

  const roleFilter = opts?.role;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // RLS scopes rows to the session org; withSessionOrgContextWithDb sets the
    // GUC so every query here is RLS-scoped. We additionally filter by role in
    // app code when opts.role is supplied.
    const rows = await tx
      .select({
        userId: membership.userId,
        fullName: appUser.fullName,
        email: appUser.email,
        role: membership.role,
      })
      .from(membership)
      .innerJoin(appUser, eq(membership.userId, appUser.id))
      .where(
        roleFilter && roleFilter.length > 0
          ? inArray(membership.role, roleFilter)
          : undefined,
      )
      .orderBy(asc(appUser.fullName), asc(appUser.email));

    return rows.map((r) => ({
      userId: r.userId,
      // fullName is nullable; fall back to email so displayName is always a string.
      displayName: r.fullName ?? r.email,
      email: r.email,
      role: r.role as MembershipRole,
    }));
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * listOrgMembers — return org-scoped members for the authenticated session.
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param opts    - Optional filters: role[] to restrict by membership role.
 * @returns OrgMemberRow[] ordered by displayName (fullName then email).
 * @throws  UnauthenticatedError | ForbiddenError.
 */
export async function listOrgMembers(
  session: AppSession | null | undefined,
  opts?: ListOrgMembersOptions,
): Promise<OrgMemberRow[]> {
  const db = await getDb();
  return _listOrgMembersImpl(db, session, opts);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/** listOrgMembersWithDb — test form; inject a pglite client. */
export async function listOrgMembersWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListOrgMembersOptions,
): Promise<OrgMemberRow[]> {
  return _listOrgMembersImpl(db, session, opts);
}
