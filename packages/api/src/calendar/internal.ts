/**
 * calendar/internal.ts — tx-level helpers for the calendar-feed slice (P1.4).
 *
 * NOT exported from @aeroops/api (except generateFeedToken, which the create
 * command needs — see index.ts). Mirrors portal/internal.ts's pattern: pure
 * tx-scoped read helpers that accept an AnyDb tx with org context ALREADY
 * set by the caller (withOrgContext / withSessionOrgContextWithDb). They
 * NEVER set GUC themselves.
 *
 * SELF-SCOPING (readCalendarEventsForUser): the `userId` argument is ALWAYS
 * the feed owner's user_id — a member's 'my_reservations' feed can only ever
 * read their OWN reservations (booker OR non-voided dispatched pilot), same
 * predicate as portal/internal.ts's readMyReservations, but WITHOUT its
 * future-only / LIMIT 20 restriction (a calendar feed shows a rolling
 * window, not just "next 20 upcoming").
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { extractRows } from '../db-rows.js';

// ─── Token generation ─────────────────────────────────────────────────────────

/**
 * generateFeedToken — a long, cryptographically-random, URL-safe opaque
 * token (32 raw bytes → 43-char base64url string, ~256 bits of entropy).
 * This IS the auth on the public .ics route — same posture as the mobile
 * bearer token (ADR-0010): possession of the token grants read access to
 * exactly the one feed it names, nothing else. Stored as-is (a bearer
 * capability, not a password — no hashing, matching the mobile-token
 * precedent).
 */
export function generateFeedToken(): string {
  return randomBytes(32).toString('base64url');
}

// ─── Calendar event row (shared shape for both scopes) ───────────────────────

export interface CalendarEventRow {
  id: string;
  startAt: Date;
  endAt: Date;
  notes: string | null;
  /** Tail number / display name (or the raw resource id as a last-resort
   * fallback) — joined by ", " when a reservation has multiple resources. */
  resourceLabel: string;
}

interface RawCalendarJoinRow {
  id: string;
  startAt: Date | string;
  endAt: Date | string;
  notes: string | null;
  resourceLabel: string;
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

// ─── readCalendarEventsForUser ────────────────────────────────────────────────

/**
 * readCalendarEventsForUser — reservations where `userId` is the booker
 * (created_by) OR a non-voided dispatched pilot, overlapping [from, to).
 * SELF-SCOPED: userId is ALWAYS the feed owner's user_id — never a
 * caller-supplied id from outside this module. Mirrors portal/internal.ts's
 * readMyReservations predicate exactly, minus its future-only/LIMIT-20
 * restriction (a calendar feed serves a bounded rolling window instead —
 * see build-ics-for-feed.ts).
 *
 * A reservation with multiple linked resources produces multiple join rows;
 * they are merged into one CalendarEventRow with resourceLabel joined by ", ".
 */
export async function readCalendarEventsForUser(
  tx: AnyDb,
  userId: string,
  from: Date,
  to: Date,
): Promise<CalendarEventRow[]> {
  const result = await tx.execute(sql`
    SELECT
      r.id,
      lower(rr.during)                                AS "startAt",
      upper(rr.during)                                AS "endAt",
      r.notes,
      COALESCE(res.tail_number, res.display_name, rr.resource_id::text) AS "resourceLabel"
    FROM reservation r
    JOIN reservation_resource rr ON rr.reservation_id = r.id
    LEFT JOIN resource res ON res.id = rr.resource_id
    WHERE r.status = 'booked'
      AND lower(rr.during) < ${to.toISOString()}::timestamptz
      AND upper(rr.during) > ${from.toISOString()}::timestamptz
      AND (
        r.created_by = ${userId}::uuid
        OR EXISTS (
          SELECT 1 FROM dispatch_ticket dt2
          WHERE dt2.reservation_id = r.id
            AND dt2.pilot_user_id = ${userId}::uuid
            AND dt2.status <> 'voided'
        )
      )
    ORDER BY lower(rr.during) ASC
  `);

  const rawRows = extractRows<RawCalendarJoinRow>(result);

  const byId = new Map<string, CalendarEventRow & { _labels: string[] }>();
  for (const r of rawRows) {
    const existing = byId.get(r.id);
    if (existing) {
      if (r.resourceLabel && !existing._labels.includes(r.resourceLabel)) {
        existing._labels.push(r.resourceLabel);
      }
    } else {
      byId.set(r.id, {
        id: r.id,
        startAt: toDate(r.startAt),
        endAt: toDate(r.endAt),
        notes: r.notes ?? null,
        resourceLabel: '',
        _labels: r.resourceLabel ? [r.resourceLabel] : [],
      });
    }
  }

  return [...byId.values()]
    .map(({ _labels, ...row }) => ({ ...row, resourceLabel: _labels.join(', ') || 'Reservation' }))
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

// ─── readCalendarEventsForResource ────────────────────────────────────────────

/**
 * readCalendarEventsForResource — one aircraft's reservations overlapping
 * [from, to). Filtered directly on the reservation_resource row for
 * `resourceId`, so (unlike readCalendarEventsForUser) no cross-reservation
 * dedupe/merge is needed — each matched reservation contributes exactly one
 * row (its link to THIS resource).
 */
export async function readCalendarEventsForResource(
  tx: AnyDb,
  resourceId: string,
  from: Date,
  to: Date,
): Promise<CalendarEventRow[]> {
  const result = await tx.execute(sql`
    SELECT
      r.id,
      lower(rr.during)                                AS "startAt",
      upper(rr.during)                                AS "endAt",
      r.notes,
      COALESCE(res.tail_number, res.display_name, rr.resource_id::text) AS "resourceLabel"
    FROM reservation r
    JOIN reservation_resource rr ON rr.reservation_id = r.id
    LEFT JOIN resource res ON res.id = rr.resource_id
    WHERE r.status = 'booked'
      AND rr.resource_id = ${resourceId}::uuid
      AND lower(rr.during) < ${to.toISOString()}::timestamptz
      AND upper(rr.during) > ${from.toISOString()}::timestamptz
    ORDER BY lower(rr.during) ASC
  `);

  const rawRows = extractRows<RawCalendarJoinRow>(result);

  return rawRows.map((r) => ({
    id: r.id,
    startAt: toDate(r.startAt),
    endAt: toDate(r.endAt),
    notes: r.notes ?? null,
    resourceLabel: r.resourceLabel || 'Reservation',
  }));
}
