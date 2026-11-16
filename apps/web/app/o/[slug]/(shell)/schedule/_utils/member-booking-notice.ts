/**
 * schedule/_utils/member-booking-notice.ts — tell the member a booking is FOR
 * when club staff book, move or cancel it ('reservation.for_member').
 *
 * Renters and students cannot book; staff book for them ("Booked for",
 * reservation.member_user_id, migration 0051). schedule/actions.ts calls these
 * AFTER the change has committed. The cancel paths also read the booking just
 * BEFORE cancelling, so cancelling one that was already cancelled (an
 * idempotent no-op) tells no one.
 *
 * BEST-EFFORT: every function here resolves and never throws. A failed read or
 * send is logged (never the e-mail body or address) and dropped, so it can
 * never fail or change the staff member's action. sendNotification logs every
 * attempt in notification_log: sent, skipped (the member turned this e-mail
 * off on their Notifications page), or failed.
 *
 * WHO IS TOLD: the member read from the reservation rows on the server
 * (getMemberBookingNoticeContext / getMemberSeriesNoticeContext), never a
 * member id the browser sent — and only when that member is not the person
 * acting (staff booking for themselves get no e-mail about it).
 *
 * WHAT IT SAYS: booked / moved (old and new times) / cancelled (the reason,
 * when one was given); aircraft by tail number and instructors by name, never
 * ids. Times are written in the acting staff member's zone (the zone their
 * schedule shows, getViewerTimeZone) — for a recurring series, the zone it
 * repeats in — and the template prints the zone's short name next to them.
 * One e-mail per recurring series, never one per date.
 *
 * NOT a 'use server' module on purpose: every export of one becomes a server
 * action the browser can call, and these may only run from the actions that
 * just made the change.
 */
import {
  getMemberBookingNoticeContext,
  getMemberSeriesNoticeContext,
  sendNotification,
} from '@aeroops/api';
import type {
  AppSession,
  BookingResourceLabels,
  CreatedReservation,
  CreateSeriesResult,
  MemberBookingFacts,
  MemberSeriesNoticeContext,
  ReservationForMemberData,
} from '@aeroops/api';
import { getViewerTimeZone } from '@/lib/viewer-time-zone';

// ─── Shared ──────────────────────────────────────────────────────────────────

/** The member to tell: set, and not the person acting. */
function memberOtherThan(session: AppSession, memberUserId: unknown): string | null {
  return typeof memberUserId === 'string' && memberUserId !== '' && memberUserId !== session.userId
    ? memberUserId
    : null;
}

function labelsOf(b: MemberBookingFacts): BookingResourceLabels {
  return { aircraft: b.aircraft, instructors: b.instructors, otherResources: b.otherResources };
}

function sameLabels(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((label, i) => label === b[i]);
}

function logFailure(what: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[notifications] member booking notice (${what}) failed:`, err instanceof Error ? err.message : err);
}

/** Runs `fn`, logging and swallowing any failure: a notice never fails the action. */
async function bestEffort(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logFailure(what, err);
  }
}

/** The zone the acting staff member's schedule shows; UTC (printed as such) if unreadable. */
async function actingZone(): Promise<string> {
  try {
    return await getViewerTimeZone();
  } catch {
    return 'UTC';
  }
}

async function send(session: AppSession, toUserId: string, templateData: ReservationForMemberData): Promise<void> {
  await sendNotification(session, { toUserId, eventType: 'reservation.for_member', templateData });
}

// ─── Booked ──────────────────────────────────────────────────────────────────

/**
 * After createReservation: tell the member the booking was made for, unless
 * they made it. `created` is the API's committed reservation (memberUserId is
 * only there when the booking names someone); the recipient is re-read from
 * the row.
 */
export function notifyMemberBooked(session: AppSession, created: CreatedReservation): Promise<void> {
  return bestEffort('booked', async () => {
    if (!memberOtherThan(session, created.memberUserId)) return;
    const ctx = await getMemberBookingNoticeContext(session, { reservationIds: [created.id] });
    const booking = ctx.bookings[0];
    const to = booking?.status === 'booked' ? memberOtherThan(session, booking.memberUserId) : null;
    if (!booking || !to) return;
    await send(session, to, {
      change: 'booked',
      ...labelsOf(booking),
      startAt: booking.startAt,
      endAt: booking.endAt,
      timeZone: await actingZone(),
      changedBy: ctx.actorDisplayName,
      orgName: ctx.orgName,
    });
  });
}

/**
 * After createSeries: ONE e-mail for the whole series — how many bookings, the
 * weekdays and time it repeats on, its first and last dates. `input` is what
 * the form sent: when it named no member, no occurrence can be for anyone and
 * nothing is read. The recipient is read from the occurrence rows.
 */
export function notifyMemberSeriesBooked(
  session: AppSession,
  result: CreateSeriesResult,
  input: unknown,
): Promise<void> {
  return bestEffort('series booked', async () => {
    const requested = typeof input === 'object' && input !== null ? (input as { memberUserId?: unknown }).memberUserId : undefined;
    if (!memberOtherThan(session, requested)) return;
    const created = result.occurrences
      .filter((o) => o.result === 'created')
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    const first = created[0];
    const last = created[created.length - 1];
    if (!first || !last) return;

    const ctx = await getMemberSeriesNoticeContext(session, { seriesId: result.series.id });
    // Every occurrence of a series is for its one member.
    const booking = ctx?.upcoming[0];
    const to = booking ? memberOtherThan(session, booking.memberUserId) : null;
    if (!ctx || !booking || !to) return;
    await send(session, to, {
      change: 'booked',
      ...labelsOf(booking),
      startAt: first.startAt,
      endAt: first.endAt,
      timeZone: ctx.series.timeZone,
      changedBy: ctx.actorDisplayName,
      orgName: ctx.orgName,
      series: {
        count: created.length,
        weekdays: ctx.series.weekdays,
        intervalWeeks: ctx.series.intervalWeeks,
        lastStartAt: last.startAt,
      },
    });
  });
}

// ─── Moved ───────────────────────────────────────────────────────────────────

/**
 * After rescheduleReservation: tell the member their booking moved — the old
 * and new times, and the old aircraft or instructor when those changed too.
 * The original row (cancelled by the move) still holds the old window. A move
 * that changed nothing the member would see sends nothing.
 */
export function notifyMemberMoved(
  session: AppSession,
  fromReservationId: string,
  moved: CreatedReservation,
): Promise<void> {
  return bestEffort('moved', async () => {
    if (!memberOtherThan(session, moved.memberUserId)) return;
    const ctx = await getMemberBookingNoticeContext(session, { reservationIds: [fromReservationId, moved.id] });
    const before = ctx.bookings.find((b) => b.reservationId === fromReservationId);
    const after = ctx.bookings.find((b) => b.reservationId === moved.id);
    const to = after?.status === 'booked' ? memberOtherThan(session, after.memberUserId) : null;
    // A move carries the member over; anything else is not this move.
    if (!before || !after || !to || before.memberUserId !== to) return;

    const sameWindow =
      before.startAt.getTime() === after.startAt.getTime() && before.endAt.getTime() === after.endAt.getTime();
    const sameResources =
      sameLabels(before.aircraft, after.aircraft) &&
      sameLabels(before.instructors, after.instructors) &&
      sameLabels(before.otherResources, after.otherResources);
    if (sameWindow && sameResources) return;

    await send(session, to, {
      change: 'moved',
      ...labelsOf(after),
      startAt: after.startAt,
      endAt: after.endAt,
      previous: { startAt: before.startAt, endAt: before.endAt, ...(sameResources ? {} : labelsOf(before)) },
      timeZone: await actingZone(),
      changedBy: ctx.actorDisplayName,
      orgName: ctx.orgName,
    });
  });
}

// ─── Cancelled ───────────────────────────────────────────────────────────────

/** Who to tell about a cancel, and what about — read just before it runs. */
export interface PendingCancelNotice {
  to: string;
  booking: MemberBookingFacts;
  changedBy: string;
  orgName: string;
}

/**
 * Before cancelReservation: the booking as it stands. null (tell no one) when
 * it is not visible, is already cancelled, names no member, or is for the
 * person acting. Never throws.
 */
export async function readCancelNotice(
  session: AppSession,
  reservationId: string,
): Promise<PendingCancelNotice | null> {
  try {
    const ctx = await getMemberBookingNoticeContext(session, { reservationIds: [reservationId] });
    const booking = ctx.bookings[0];
    const to = booking?.status === 'booked' ? memberOtherThan(session, booking.memberUserId) : null;
    return booking && to ? { to, booking, changedBy: ctx.actorDisplayName, orgName: ctx.orgName } : null;
  } catch (err) {
    logFailure('cancel read', err);
    return null;
  }
}

/**
 * After cancelReservation committed: tell the member, with the reason staff
 * gave (trimmed as cancelReservation stores it; none → no reason line).
 */
export function notifyMemberCancelled(
  session: AppSession,
  pending: PendingCancelNotice | null,
  reason: string | undefined,
): Promise<void> {
  return bestEffort('cancelled', async () => {
    if (!pending) return;
    await send(session, pending.to, {
      change: 'cancelled',
      ...labelsOf(pending.booking),
      startAt: pending.booking.startAt,
      endAt: pending.booking.endAt,
      reason: reason?.trim() || null,
      timeZone: await actingZone(),
      changedBy: pending.changedBy,
      orgName: pending.orgName,
    });
  });
}

/** Who to tell about a series cancel, and its upcoming bookings — read just before it runs. */
export interface PendingSeriesCancelNotice {
  to: string;
  context: MemberSeriesNoticeContext;
}

/**
 * Before cancelSeries: the series and the upcoming bookings it would cancel.
 * null (tell no one) when it is not visible, is already cancelled, has no
 * upcoming booking, names no member, or is for the person acting. Never throws.
 */
export async function readSeriesCancelNotice(
  session: AppSession,
  seriesId: string,
): Promise<PendingSeriesCancelNotice | null> {
  try {
    const ctx = await getMemberSeriesNoticeContext(session, { seriesId });
    const first = ctx?.series.status === 'active' ? ctx.upcoming[0] : undefined;
    const to = first ? memberOtherThan(session, first.memberUserId) : null;
    return ctx && to ? { to, context: ctx } : null;
  } catch (err) {
    logFailure('series cancel read', err);
    return null;
  }
}

/**
 * After cancelSeries committed: ONE e-mail for the series — how many upcoming
 * bookings were cancelled (`cancelledCount`, the API's own count), the
 * weekdays and time, the first and last dates, and the reason staff gave.
 */
export function notifyMemberSeriesCancelled(
  session: AppSession,
  pending: PendingSeriesCancelNotice | null,
  cancelledCount: number,
  reason: string | undefined,
): Promise<void> {
  return bestEffort('series cancelled', async () => {
    if (!pending || cancelledCount <= 0) return;
    const { context: ctx, to } = pending;
    const mine = ctx.upcoming.filter((b) => b.memberUserId === to);
    const first = mine[0];
    const last = mine[mine.length - 1];
    if (!first || !last) return;
    await send(session, to, {
      change: 'cancelled',
      ...labelsOf(first),
      startAt: first.startAt,
      endAt: first.endAt,
      reason: reason?.trim() || null,
      timeZone: ctx.series.timeZone,
      changedBy: ctx.actorDisplayName,
      orgName: ctx.orgName,
      series: {
        count: cancelledCount,
        weekdays: ctx.series.weekdays,
        intervalWeeks: ctx.series.intervalWeeks,
        lastStartAt: last.startAt,
      },
    });
  });
}
