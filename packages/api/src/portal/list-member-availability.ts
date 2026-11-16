/**
 * list-member-availability.ts — the member Schedule's read: when the org's
 * aircraft and instructors are taken, without saying by whom.
 *
 * Renters and students cannot book (club staff book for them), and until now
 * they could not see when an aircraft is free either, so they could not ask
 * staff for a sensible time. listMemberAvailability gives them that, read-only.
 *
 * listMemberAvailability(session, { from, to }) — for the org's ACTIVE aircraft
 * and instructor resources (sims, rooms and vehicles are left out), every
 * interval overlapping the half-open window [from, to) during which each one
 * is taken:
 *   'booked'      — a reservation_resource row with status 'booked'. A
 *                   cancelled booking frees its time and is left out.
 *   'unavailable' — a resource_blackout window.
 * and, for each aircraft, the operator's grounding state (latest
 * aircraft_grounding event, ADR-0008) as a bare boolean.
 *
 * OVERLAP (ADR-0004 invariant 6): half-open on both sides. An interval is in
 * the window iff start < to AND end > from (`&&` on '[)' ranges): one that
 * ends exactly at `from`, or starts exactly at `to`, is not. Intervals are
 * returned whole (not clipped to the window).
 *
 * PRIVACY — THE LOAD-BEARING REQUIREMENT. Every member of the org sees this.
 * An interval the caller is NOT part of says only WHEN a resource is taken:
 *   { resourceId, startAt, endAt, kind }
 * Never the reservation id, its series, who booked it, who it is for, who is
 * flying it, or its notes. Those columns do not even leave the database for
 * such rows (CASE WHEN mine …). A blackout likewise drops its reason and
 * creator, and grounding drops its reason and squawk.
 * An interval the caller IS part of — the same three links as the portal's
 * readMyReservations:
 *   reservation.created_by = me,
 *   reservation.member_user_id = me (booked for me, migration 0051), or
 *   a NON-VOIDED dispatch_ticket on it with pilot_user_id = me
 * — is flagged `mine: true` and carries its notes and the display labels of
 * every resource on the booking (tail #s, instructor names; never ids).
 *
 * SELF-SCOPING: "me" is ALWAYS session.userId from the verified JWT. The input
 * is the window only — no user, reservation or resource id is read from it.
 *
 * GUARANTEES:
 *   - requireCapability('portal:access') FIRST: renter and student; owner and
 *     manager hold it too and may call it. portal:access stays STANDALONE —
 *     this is its own read, NOT listReservations (schedule:access), which a
 *     portal-only role still cannot call.
 *   - org_id from session only: ONE withSessionOrgContextWithDb transaction,
 *     RLS scoping every table read (resource, reservation_resource,
 *     reservation, dispatch_ticket, resource_blackout, aircraft_grounding).
 *   - Bounded input: real Dates, from < to, at most 31 days, else
 *     ValidationError (a server action is callable with anything).
 *   - No N+1: at most 5 queries whatever the fleet size. Reads NOT audited.
 *     NO money.
 *
 * COMPLIANCE: `grounded` is operator data (ADR-0008) shown as the bare state —
 * NOT an airworthiness or return-to-service determination. The alerts bell
 * already tells an affected pilot an aircraft "is grounded" ([VERIFY-N1-A]);
 * showing the same bare state to every member of the org is provisional
 * [VERIFY-MS-A].
 *
 * TWO CALLING FORMS:
 *   listMemberAvailability(session, input)          — app code; uses getDb().
 *   listMemberAvailabilityWithDb(db, session, input) — tests; inject pglite.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { resource } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { extractRows } from '../db-rows.js';
import { loadGroundingProbe } from '../maintenance/internal.js';
import { ValidationError } from '../scheduling/internal.js';

// ─── Public types ─────────────────────────────────────────────────────────────

/** Input: the half-open window [from, to). Nothing else is read from it. */
export interface ListMemberAvailabilityInput {
  /** Start of the window (inclusive). */
  from: Date;
  /** End of the window (exclusive). At most 31 days after `from`. */
  to: Date;
}

/** The longest window one call may ask for. */
export const MEMBER_AVAILABILITY_MAX_DAYS = 31;

/** One active aircraft or instructor resource of the caller's org. */
export interface MemberAvailabilityResource {
  id: string;
  kind: 'aircraft' | 'instructor';
  /** Aircraft: the tail number. Instructor: the resource's display name. */
  label: string;
  /** Aircraft identity (free text, operator-entered); null for an instructor. */
  make: string | null;
  model: string | null;
  /**
   * Aircraft: the operator's current grounding state (latest
   * aircraft_grounding event is 'grounded'). Operator data, NOT an
   * airworthiness determination. Always false for an instructor.
   */
  grounded: boolean;
}

/**
 * When a resource is taken by someone else's booking ('booked') or blocked out
 * by staff ('unavailable'). EXACTLY these four keys — nothing that says who.
 */
export interface MemberAvailabilityBusyInterval {
  resourceId: string;
  startAt: Date;
  endAt: Date;
  kind: 'booked' | 'unavailable';
  /** Never present: lets `interval.mine` narrow the union. */
  mine?: never;
}

/** A booking the caller is part of (booker, booked for, or dispatched pilot). */
export interface MemberAvailabilityMyInterval {
  resourceId: string;
  startAt: Date;
  endAt: Date;
  kind: 'booked';
  mine: true;
  notes: string | null;
  /** Every resource on the booking: tail #s first, then display names. */
  resourceLabels: string[];
}

export type MemberAvailabilityInterval =
  | MemberAvailabilityBusyInterval
  | MemberAvailabilityMyInterval;

export interface MemberAvailabilityResult {
  /** Aircraft first (by tail #), then instructors (by name). */
  resources: MemberAvailabilityResource[];
  /** Ordered by start, end, resource; one entry per resource per booking. */
  intervals: MemberAvailabilityInterval[];
}

// ─── Input validation ─────────────────────────────────────────────────────────

const MAX_WINDOW_MS = MEMBER_AVAILABILITY_MAX_DAYS * 24 * 60 * 60 * 1000;

function isRealDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/** The validated window, or ValidationError. Never reads anything but from/to. */
function parseWindow(rawInput: unknown): { from: Date; to: Date } {
  const raw = (typeof rawInput === 'object' && rawInput !== null ? rawInput : {}) as {
    from?: unknown;
    to?: unknown;
  };
  if (!isRealDate(raw.from) || !isRealDate(raw.to)) {
    throw new ValidationError('[portal] The schedule window needs a valid start and end.');
  }
  const span = raw.to.getTime() - raw.from.getTime();
  if (span <= 0) {
    throw new ValidationError('[portal] The schedule window must end after it starts.');
  }
  if (span > MAX_WINDOW_MS) {
    throw new ValidationError(
      `[portal] The schedule window can be at most ${MEMBER_AVAILABILITY_MAX_DAYS} days.`,
    );
  }
  return { from: raw.from, to: raw.to };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Aircraft before instructors; then by label (natural: N2 before N10); then id. */
function compareResources(a: MemberAvailabilityResource, b: MemberAvailabilityResource): number {
  if (a.kind !== b.kind) return a.kind === 'aircraft' ? -1 : 1;
  const byLabel = a.label.localeCompare(b.label, 'en', { numeric: true, sensitivity: 'base' });
  if (byLabel !== 0) return byLabel;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareIntervals(a: MemberAvailabilityInterval, b: MemberAvailabilityInterval): number {
  const byStart = a.startAt.getTime() - b.startAt.getTime();
  if (byStart !== 0) return byStart;
  const byEnd = a.endAt.getTime() - b.endAt.getTime();
  if (byEnd !== 0) return byEnd;
  if (a.resourceId !== b.resourceId) return a.resourceId < b.resourceId ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === 'booked' ? -1 : 1;
  return 0;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _listMemberAvailabilityImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<MemberAvailabilityResult> {
  // 1. AUTHZ FIRST — before any data access.
  requireCapability(session, 'portal:access');

  // 2. VALIDATE — the window is the only input.
  const { from, to } = parseWindow(rawInput);

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // SELF-SCOPED: "me" is the verified session subject, never caller input.
    const me = sess.userId;
    const windowRange = sql`tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz, '[)')`;

    // ── Q1. The org's active aircraft + instructors (RLS-scoped). ──────────
    const resourceRows = await tx
      .select({
        id: resource.id,
        kind: resource.kind,
        displayName: resource.displayName,
        tailNumber: resource.tailNumber,
        make: resource.make,
        model: resource.model,
      })
      .from(resource)
      .where(and(eq(resource.active, true), inArray(resource.kind, ['aircraft', 'instructor'])));

    if (resourceRows.length === 0) {
      return { resources: [], intervals: [] };
    }

    // ── Q2. Booked intervals; only MY bookings bring their id + notes out. ─
    // member_user_id IS NOT DISTINCT FROM: a booking for no one (NULL) is
    // plainly "not for me", so `mine` is always a real boolean, never NULL.
    const bookedResult = await tx.execute(sql`
      WITH booked AS (
        SELECT
          rr.resource_id   AS resource_id,
          lower(rr.during) AS start_at,
          upper(rr.during) AS end_at,
          r.id             AS reservation_id,
          r.notes          AS notes,
          (
            r.created_by = ${me}::uuid
            OR r.member_user_id IS NOT DISTINCT FROM ${me}::uuid
            OR EXISTS (
              SELECT 1 FROM dispatch_ticket dt
              WHERE dt.reservation_id = r.id
                AND dt.pilot_user_id = ${me}::uuid
                AND dt.status <> 'voided'
            )
          ) AS mine
        FROM reservation_resource rr
        JOIN reservation r ON r.id = rr.reservation_id
        JOIN resource res ON res.id = rr.resource_id
        WHERE rr.status = 'booked'
          AND r.status = 'booked'
          AND res.active = true
          AND res.kind IN ('aircraft', 'instructor')
          AND rr.during && ${windowRange}
      )
      SELECT
        resource_id                            AS "resourceId",
        start_at                               AS "startAt",
        end_at                                 AS "endAt",
        mine                                   AS "mine",
        CASE WHEN mine THEN reservation_id END AS "myReservationId",
        CASE WHEN mine THEN notes END          AS "myNotes"
      FROM booked
    `);
    const bookedRows = extractRows<{
      resourceId: string;
      startAt: Date | string;
      endAt: Date | string;
      mine: boolean | null;
      myReservationId: string | null;
      myNotes: string | null;
    }>(bookedResult);

    // ── Q3. Labels of every resource on MY bookings (none → no query). ─────
    const myReservationIds = [
      ...new Set(
        bookedRows
          .filter((r) => r.mine === true && r.myReservationId)
          .map((r) => r.myReservationId as string),
      ),
    ];
    const labelsByReservation = new Map<string, string[]>();
    if (myReservationIds.length > 0) {
      const idList = sql.join(
        myReservationIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const labelResult = await tx.execute(sql`
        SELECT
          rr.reservation_id AS "reservationId",
          COALESCE(res.tail_number, res.display_name, rr.resource_id::text) AS "label",
          (res.kind = 'aircraft') AS "isAircraft"
        FROM reservation_resource rr
        LEFT JOIN resource res ON res.id = rr.resource_id
        WHERE rr.reservation_id = ANY(ARRAY[${idList}])
      `);
      const labelRows = extractRows<{
        reservationId: string;
        label: string;
        isAircraft: boolean | null;
      }>(labelResult);
      labelRows.sort((a, b) => {
        if ((a.isAircraft === true) !== (b.isAircraft === true)) return a.isAircraft === true ? -1 : 1;
        return a.label.localeCompare(b.label, 'en', { numeric: true, sensitivity: 'base' });
      });
      for (const row of labelRows) {
        const labels = labelsByReservation.get(row.reservationId) ?? [];
        if (!labels.includes(row.label)) labels.push(row.label);
        labelsByReservation.set(row.reservationId, labels);
      }
    }

    // ── Q4. Blackouts as "unavailable" — when only (no reason, no creator). ─
    const blackoutResult = await tx.execute(sql`
      SELECT
        b.resource_id   AS "resourceId",
        lower(b.during) AS "startAt",
        upper(b.during) AS "endAt"
      FROM resource_blackout b
      JOIN resource res ON res.id = b.resource_id
      WHERE res.active = true
        AND res.kind IN ('aircraft', 'instructor')
        AND b.during && ${windowRange}
    `);
    const blackoutRows = extractRows<{
      resourceId: string;
      startAt: Date | string;
      endAt: Date | string;
    }>(blackoutResult);

    // ── Q5. Grounding: the bare state per aircraft (one DISTINCT ON query). ─
    const aircraftIds = resourceRows.filter((r) => r.kind === 'aircraft').map((r) => r.id);
    const grounding = await loadGroundingProbe(tx, aircraftIds);

    // ── Assemble. Each object is built key by key: nothing rides along. ────
    const resources: MemberAvailabilityResource[] = resourceRows.map((r) => {
      const isAircraft = r.kind === 'aircraft';
      return {
        id: r.id,
        kind: isAircraft ? 'aircraft' : 'instructor',
        label: isAircraft ? (r.tailNumber ?? r.displayName) : r.displayName,
        make: isAircraft ? (r.make ?? null) : null,
        model: isAircraft ? (r.model ?? null) : null,
        grounded: isAircraft ? (grounding.get(r.id)?.grounded ?? false) : false,
      };
    });
    resources.sort(compareResources);

    const intervals: MemberAvailabilityInterval[] = [];
    for (const row of bookedRows) {
      const startAt = toDate(row.startAt);
      const endAt = toDate(row.endAt);
      if (row.mine === true && row.myReservationId) {
        intervals.push({
          resourceId: row.resourceId,
          startAt,
          endAt,
          kind: 'booked',
          mine: true,
          notes: row.myNotes ?? null,
          resourceLabels: [...(labelsByReservation.get(row.myReservationId) ?? [])],
        });
      } else {
        intervals.push({ resourceId: row.resourceId, startAt, endAt, kind: 'booked' });
      }
    }
    for (const row of blackoutRows) {
      intervals.push({
        resourceId: row.resourceId,
        startAt: toDate(row.startAt),
        endAt: toDate(row.endAt),
        kind: 'unavailable',
      });
    }
    intervals.sort(compareIntervals);

    return { resources, intervals };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * listMemberAvailability — when the org's aircraft and instructors are taken
 * in [from, to); others' bookings say when only, the caller's own say more.
 *
 * @throws UnauthenticatedError | ForbiddenError (no portal:access) | ValidationError.
 */
export async function listMemberAvailability(
  session: AppSession | null | undefined,
  input: ListMemberAvailabilityInput,
): Promise<MemberAvailabilityResult> {
  const db = await getDb();
  return _listMemberAvailabilityImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/** listMemberAvailabilityWithDb — test form; inject a pglite client. */
export async function listMemberAvailabilityWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: ListMemberAvailabilityInput,
): Promise<MemberAvailabilityResult> {
  return _listMemberAvailabilityImpl(db, session, input);
}
