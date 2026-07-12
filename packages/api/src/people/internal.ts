/**
 * people/internal.ts — tx-level helpers for people reads.
 *
 * NOT exported from @aeroops/api. Holds:
 *   assembleMemberDetail(tx, userId) — full aggregation inside an existing
 *     org context (RLS-scoped by the caller). Used by getMemberDetail (read)
 *     AND by post-write re-reads so both paths share exactly the same query
 *     logic and can never diverge.
 *
 * INVARIANT: All helpers accept an AnyDb tx with org GUC already set by the
 * caller's withSessionOrgContextWithDb. They NEVER set GUC themselves.
 *
 * [VERIFY-6-A]: tags are free-text opaque labels. No FAA meaning computed.
 * [VERIFY-6-C]: upcomingReservations = created_by, not flight assignment.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import type { MembershipRole } from '@aeroops/core';
import { toDispatchTicketView } from '../dispatch/internal.js';
import type {
  MemberDetail,
  MemberTagView,
  MemberTagColor,
  UpcomingMemberReservationRow,
} from './types.js';
import type { DispatchTicketView } from '../dispatch/types.js';
import { extractRows } from '../db-rows.js';

// ─── assembleMemberDetail ─────────────────────────────────────────────────────

/**
 * assembleMemberDetail — full member-detail aggregation inside an existing
 * org context (RLS-scoped by the caller's withSessionOrgContextWithDb).
 *
 * Returns null when the userId is not a visible member (cross-org RLS blocks
 * it, or has no membership row). Callers map null → not_found.
 *
 * Deactivated member → full detail (not null). not_found only for invisible/
 * cross-org/non-member ids.
 *
 * Runs 4 queries: identity, tags, upcoming reservations, recent dispatch.
 * NEVER sets org GUC itself.
 */
export async function assembleMemberDetail(
  tx: AnyDb,
  userId: string,
): Promise<MemberDetail | null> {
  // ── 1. Identity row (JOIN membership + app_user, RLS-scoped) ──────────────
  const identityResult = await tx.execute(sql`
    SELECT
      m.user_id      AS "userId",
      u.full_name    AS "fullName",
      u.email,
      u.phone,
      u.status,
      m.role,
      m.created_at   AS "joinedAt"
    FROM membership m
    JOIN app_user u ON u.id = m.user_id
    WHERE m.user_id = ${userId}::uuid
    LIMIT 1
  `);

  const identityRows = extractRows<{
    userId: string;
    fullName: string | null;
    email: string;
    phone: string | null;
    status: string;
    role: string;
    joinedAt: Date | string;
  }>(identityResult);

  const identity = identityRows[0];
  if (!identity) return null;

  // ── 1b. Login presence (EXISTS only — the password hash is NEVER read) ────
  // Drives the "no login yet" hint. RLS-scoped; we check existence of an
  // auth_credential row, never its contents (auth boundary stays clean).
  const credResult = await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM auth_credential WHERE user_id = ${userId}::uuid
    ) AS "hasLogin"
  `);
  const credRows = extractRows<{ hasLogin: boolean }>(credResult);
  const hasLogin = credRows[0]?.hasLogin === true;

  // ── 2. Tags (ORDER BY tag ASC) ────────────────────────────────────────────
  // [VERIFY-6-A]: free-text opaque labels only.
  const tagsResult = await tx.execute(sql`
    SELECT
      id,
      tag,
      color,
      created_by  AS "createdBy",
      created_at  AS "createdAt"
    FROM member_tag
    WHERE user_id = ${userId}::uuid
    ORDER BY tag ASC
  `);

  const tagRows = extractRows<{
    id: string;
    tag: string;
    color: string | null;
    createdBy: string;
    createdAt: Date | string;
  }>(tagsResult);

  const tags: MemberTagView[] = tagRows.map((r) => ({
    id: r.id,
    tag: r.tag,
    color: (r.color as MemberTagColor | null) ?? null,
    createdBy: r.createdBy,
    createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
  }));

  // ── 3. Upcoming reservations BOOKED BY this member ─────────────────────────
  // [VERIFY-6-C]: reservation.created_by — booking owner, NOT flight assignment.
  const reservationsResult = await tx.execute(sql`
    SELECT
      r.id,
      lower(rr.during) AS "startAt",
      upper(rr.during) AS "endAt",
      r.series_id       AS "seriesId"
    FROM reservation r
    JOIN reservation_resource rr ON rr.reservation_id = r.id
    WHERE r.created_by = ${userId}::uuid
      AND r.status = 'booked'
      AND lower(rr.during) > NOW()
    ORDER BY lower(rr.during) ASC
    LIMIT 10
  `);

  const resRows = extractRows<{
    id: string;
    startAt: Date | string;
    endAt: Date | string;
    seriesId: string | null;
  }>(reservationsResult);

  const upcomingReservations: UpcomingMemberReservationRow[] = resRows.map((r) => ({
    id: r.id,
    startAt: r.startAt instanceof Date ? r.startAt : new Date(r.startAt),
    endAt:   r.endAt   instanceof Date ? r.endAt   : new Date(r.endAt),
    seriesId: r.seriesId ?? null,
  }));

  // ── 4. Recent dispatch as pilot (incl. voided, newest-first, ≤10) ─────────
  const dispatchResult = await tx.execute(sql`
    SELECT
      id,
      org_id            AS "orgId",
      reservation_id    AS "reservationId",
      resource_id       AS "resourceId",
      pilot_user_id     AS "pilotUserId",
      status,
      hobbs_out         AS "hobbsOut",
      tach_out          AS "tachOut",
      hobbs_in          AS "hobbsIn",
      tach_in           AS "tachIn",
      flight_time_hours AS "flightTimeHours",
      notes,
      opened_by         AS "openedBy",
      opened_at         AS "openedAt",
      closed_by         AS "closedBy",
      closed_at         AS "closedAt",
      created_at        AS "createdAt",
      updated_at        AS "updatedAt"
    FROM dispatch_ticket
    WHERE pilot_user_id = ${userId}::uuid
    ORDER BY created_at DESC
    LIMIT 10
  `);

  const dispatchRows = extractRows<{
    id: string;
    orgId: string;
    reservationId: string;
    resourceId: string;
    pilotUserId: string;
    status: string;
    hobbsOut: string | number;
    tachOut: string | number;
    hobbsIn: string | number | null;
    tachIn: string | number | null;
    flightTimeHours: string | number | null;
    notes: string | null;
    openedBy: string;
    openedAt: Date | string;
    closedBy: string | null;
    closedAt: Date | string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
  }>(dispatchResult);

  const recentDispatch: DispatchTicketView[] = dispatchRows.map(toDispatchTicketView);

  return {
    userId: identity.userId,
    displayName: identity.fullName ?? identity.email,
    email: identity.email,
    phone: identity.phone,
    status: identity.status,
    role: identity.role as MembershipRole,
    joinedAt: identity.joinedAt instanceof Date
      ? identity.joinedAt
      : new Date(identity.joinedAt),
    hasLogin,
    tags,
    upcomingReservations,
    recentDispatch,
  };
}
