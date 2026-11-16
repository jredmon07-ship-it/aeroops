/**
 * notifications/member-booking-notice.ts — the facts a member's
 * 'reservation.for_member' e-mail is written from, read on the server.
 *
 * Renters and students cannot book; club staff book, move and cancel bookings
 * FOR them (reservation.member_user_id, migration 0051). The web action layer
 * tells that member by e-mail, best-effort, once the change has committed
 * (apps/web schedule/actions.ts → schedule/_utils/member-booking-notice.ts).
 * Everything the e-mail names is read HERE from the reservation rows, never
 * taken from what the browser sent:
 *
 *   - who the booking is for (reservation.member_user_id),
 *   - its window and status, and the cancellation reason stored on it,
 *   - what is booked, as labels people read: an aircraft's tail number (its
 *     display name when it has none), an instructor's display name, any other
 *     resource's display name — never a resource id,
 *   - who is acting: the session user's full name, else e-mail,
 *   - the org's name.
 *
 * READ-ONLY: no writes, no audit row. Gated on schedule:access — every role
 * that can book, move or cancel (schedule:create_reservation) holds it.
 * RLS-scoped through withSessionOrgContext: a reservation or series in another
 * org is simply not returned, and org_id is never an input. An id that is not
 * a UUID is skipped (never sent to Postgres).
 *
 * TWO CALLING FORMS per read:
 *   fn(session, input)              — app code; getDb().
 *   fnWithDb(db, session, input)    — tests; inject pglite.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { appUser, org, reservation, reservationResource, reservationSeries, resource } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type { BookingResourceLabels } from './email-event-types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Most reservations one read loads (a move reads two: before and after). */
const MAX_RESERVATIONS = 10;

/** A series never has more occurrences than createSeries' hard cap. */
const MAX_SERIES_OCCURRENCES = 52;

// ─── Result types ─────────────────────────────────────────────────────────────

/** One booking as a member's notice describes it. */
export interface MemberBookingFacts extends BookingResourceLabels {
  reservationId: string;
  status: 'booked' | 'cancelled';
  startAt: Date;
  endAt: Date;
  /** Who it is for (reservation.member_user_id); null when it names no one. */
  memberUserId: string | null;
  seriesId: string | null;
  /** The reason stored when it was cancelled (migration 0042); null otherwise. */
  cancellationReason: string | null;
}

/** Who is making the change, and where. */
export interface MemberNoticeActor {
  /** The session user's full name, else e-mail. */
  actorDisplayName: string;
  /** The org's name ("at Bravo Flying Club"). */
  orgName: string;
}

export interface MemberBookingNoticeContext extends MemberNoticeActor {
  /** One entry per requested id visible in the org, in request order. */
  bookings: MemberBookingFacts[];
}

export interface MemberSeriesNoticeContext extends MemberNoticeActor {
  series: {
    id: string;
    status: 'active' | 'cancelled';
    /** ISO weekdays 1..7 (Mon..Sun). */
    weekdays: number[];
    intervalWeeks: number;
    /** The IANA zone the series repeats in (its weekdays + wall-clock time). */
    timeZone: string;
  };
  /**
   * Its booked occurrences that start after now, earliest first: exactly the
   * ones cancelSeries would cancel. Every occurrence of a series is for the
   * same member (createSeries names one; a moved occurrence leaves the series).
   */
  upcoming: MemberBookingFacts[];
}

// ─── Shared reads (inside the caller's org-scoped tx) ─────────────────────────

async function readActor(tx: AnyDb, sess: AppSession): Promise<MemberNoticeActor> {
  const users = await tx
    .select({ fullName: appUser.fullName, email: appUser.email })
    .from(appUser)
    .where(eq(appUser.id, sess.userId))
    .limit(1);
  const orgs = await tx.select({ name: org.name }).from(org).where(eq(org.id, sess.orgId)).limit(1);
  const user = users[0];
  return {
    actorDisplayName: user?.fullName?.trim() || user?.email || 'Club staff',
    orgName: orgs[0]?.name ?? '',
  };
}

/** The facts for `ids` (already UUID-checked), in `ids` order; unseen ids are left out. */
async function readBookingFacts(tx: AnyDb, ids: string[]): Promise<MemberBookingFacts[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({
      id: reservation.id,
      status: reservation.status,
      startAt: reservation.startAt,
      endAt: reservation.endAt,
      memberUserId: reservation.memberUserId,
      seriesId: reservation.seriesId,
      cancellationReason: reservation.cancellationReason,
      kind: resource.kind,
      tailNumber: resource.tailNumber,
      displayName: resource.displayName,
    })
    .from(reservation)
    .leftJoin(reservationResource, eq(reservationResource.reservationId, reservation.id))
    .leftJoin(resource, eq(resource.id, reservationResource.resourceId))
    .where(inArray(reservation.id, ids))
    .orderBy(asc(resource.kind), asc(resource.displayName));

  const byId = new Map<string, MemberBookingFacts>();
  for (const row of rows) {
    let facts = byId.get(row.id);
    if (!facts) {
      facts = {
        reservationId: row.id,
        status: row.status,
        startAt: row.startAt,
        endAt: row.endAt,
        memberUserId: row.memberUserId ?? null,
        seriesId: row.seriesId ?? null,
        cancellationReason: row.cancellationReason ?? null,
        aircraft: [],
        instructors: [],
        otherResources: [],
      };
      byId.set(row.id, facts);
    }
    // No join row, or a resource RLS hides: nothing to label.
    if (!row.kind || !row.displayName) continue;
    const list =
      row.kind === 'aircraft' ? facts.aircraft : row.kind === 'instructor' ? facts.instructors : facts.otherResources;
    const label = (row.kind === 'aircraft' ? row.tailNumber?.trim() : undefined) || row.displayName;
    if (!list.includes(label)) list.push(label);
  }
  return ids.flatMap((id) => byId.get(id) ?? []);
}

// ─── getMemberBookingNoticeContext ────────────────────────────────────────────

export interface GetMemberBookingNoticeContextInput {
  reservationIds: string[];
}

async function _getMemberBookingNoticeContextImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetMemberBookingNoticeContextInput,
): Promise<MemberBookingNoticeContext> {
  requireCapability(session, 'schedule:access');
  const ids = [...new Set(input.reservationIds.filter((id) => UUID_RE.test(id)))].slice(0, MAX_RESERVATIONS);
  return withSessionOrgContextWithDb(db, session, async (sess, tx) => ({
    ...(await readActor(tx, sess)),
    bookings: await readBookingFacts(tx, ids),
  }));
}

/**
 * getMemberBookingNoticeContext — the bookings `reservationIds` name (any
 * status, so a just-cancelled or just-moved row still reads), with who is
 * acting and the org's name.
 */
export async function getMemberBookingNoticeContext(
  session: AppSession | null | undefined,
  input: GetMemberBookingNoticeContextInput,
): Promise<MemberBookingNoticeContext> {
  const db = await getDb();
  return _getMemberBookingNoticeContextImpl(db, session, input);
}

export async function getMemberBookingNoticeContextWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetMemberBookingNoticeContextInput,
): Promise<MemberBookingNoticeContext> {
  return _getMemberBookingNoticeContextImpl(db, session, input);
}

// ─── getMemberSeriesNoticeContext ─────────────────────────────────────────────

export interface GetMemberSeriesNoticeContextInput {
  seriesId: string;
}

async function _getMemberSeriesNoticeContextImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetMemberSeriesNoticeContextInput,
  opts?: { now?: number },
): Promise<MemberSeriesNoticeContext | null> {
  requireCapability(session, 'schedule:access');
  if (!UUID_RE.test(input.seriesId)) return null;
  const nowIso = new Date(opts?.now ?? Date.now()).toISOString();

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const seriesRows = await tx
      .select({
        id: reservationSeries.id,
        status: reservationSeries.status,
        weekdays: reservationSeries.weekdays,
        intervalWeeks: reservationSeries.intervalWeeks,
        ianaTz: reservationSeries.ianaTz,
      })
      .from(reservationSeries)
      .where(eq(reservationSeries.id, input.seriesId))
      .limit(1);
    const series = seriesRows[0];
    if (!series) return null;

    // The same predicate cancelSeries cancels by: booked AND start_at > now.
    const upcomingRows = await tx
      .select({ id: reservation.id })
      .from(reservation)
      .where(
        and(
          eq(reservation.seriesId, series.id),
          eq(reservation.status, 'booked'),
          sql`${reservation.startAt} > ${nowIso}::timestamptz`,
        ),
      )
      .orderBy(asc(reservation.startAt))
      .limit(MAX_SERIES_OCCURRENCES);

    return {
      ...(await readActor(tx, sess)),
      series: {
        id: series.id,
        status: series.status,
        weekdays: series.weekdays,
        intervalWeeks: series.intervalWeeks,
        timeZone: series.ianaTz,
      },
      upcoming: await readBookingFacts(
        tx,
        upcomingRows.map((r) => r.id),
      ),
    };
  });
}

/**
 * getMemberSeriesNoticeContext — a recurring series' rule (weekdays, every N
 * weeks, its zone) and its upcoming booked occurrences, with who is acting.
 * null when the series is not visible in the org.
 */
export async function getMemberSeriesNoticeContext(
  session: AppSession | null | undefined,
  input: GetMemberSeriesNoticeContextInput,
): Promise<MemberSeriesNoticeContext | null> {
  const db = await getDb();
  return _getMemberSeriesNoticeContextImpl(db, session, input);
}

/** Test form: inject pglite; `opts.now` pins "upcoming" (epoch ms). */
export async function getMemberSeriesNoticeContextWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetMemberSeriesNoticeContextInput,
  opts?: { now?: number },
): Promise<MemberSeriesNoticeContext | null> {
  return _getMemberSeriesNoticeContextImpl(db, session, input, opts);
}
