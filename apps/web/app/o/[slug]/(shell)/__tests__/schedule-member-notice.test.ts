/**
 * schedule-member-notice.test.ts — the schedule actions tell the member a
 * booking is FOR when club staff book, move or cancel it
 * ('reservation.for_member'; schedule/actions.ts →
 * schedule/_utils/member-booking-notice.ts).
 *
 * COVERAGE:
 *   1. createReservationAction — the member is told when the booker is
 *      someone else (the booker's own 'reservation.created' is unchanged);
 *      nobody extra when the booker is the member or there is no member; the
 *      recipient is the member read from the row, never the request's.
 *   2. createSeriesAction — ONE e-mail for the series (count, weekdays, first
 *      and last dates, the series' zone), never one per occurrence.
 *   3. rescheduleAction — old and new times; old labels when they changed;
 *      nothing for the mover themselves or a move that changed nothing.
 *   4. cancelReservationAction — read BEFORE the cancel; the reason; nothing
 *      for a repeat cancel of an already-cancelled booking.
 *   5. cancelSeriesAction — ONE e-mail with the count cancelled.
 *   6. Every action still returns its own result when sendNotification (or
 *      the facts read) rejects, and refused changes tell no one.
 *
 * '@aeroops/api', '@/lib/action-auth' and '@/lib/viewer-time-zone' are
 * mocked: no DB, no next-auth, no request cookies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { actionAuth, viewerZone, api } = vi.hoisted(() => ({
  actionAuth: vi.fn(),
  viewerZone: vi.fn(async () => 'America/Chicago'),
  api: {
    createReservation: vi.fn(),
    createSeries: vi.fn(),
    rescheduleReservation: vi.fn(),
    cancelReservation: vi.fn(),
    cancelSeries: vi.fn(),
    sendNotification: vi.fn(),
    getMemberBookingNoticeContext: vi.fn(),
    getMemberSeriesNoticeContext: vi.fn(),
  },
}));

vi.mock('@/lib/action-auth', () => ({ actionAuth }));
vi.mock('@/lib/viewer-time-zone', () => ({ getViewerTimeZone: viewerZone }));
vi.mock('@aeroops/api', () => ({
  ...api,
  // lib/action-errors-result.ts maps these with instanceof.
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
}));

import {
  createReservationAction,
  createSeriesAction,
  rescheduleAction,
  cancelReservationAction,
  cancelSeriesAction,
} from '../schedule/actions';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STAFF = 'staff-dana';
const MEMBER = 'member-riley';
const session = { userId: STAFF, orgId: 'o', slug: 'bravo', role: 'dispatcher', user: { email: 'dana@bravo.example' } };

/** Mon Nov 16 2026, 10:00–11:30 CST. */
const START = new Date('2026-11-16T16:00:00.000Z');
const END = new Date('2026-11-16T17:30:00.000Z');
/** Tue Nov 17 2026, 14:00–15:30 CST. */
const NEW_START = new Date('2026-11-17T20:00:00.000Z');
const NEW_END = new Date('2026-11-17T21:30:00.000Z');

function created(memberUserId?: string, id = 'r-1') {
  return {
    id,
    orgId: 'o',
    startAt: START,
    endAt: END,
    status: 'booked' as const,
    notes: null,
    createdBy: STAFF,
    resourceIds: ['res-aircraft', 'res-cfi'],
    ...(memberUserId ? { memberUserId } : {}),
  };
}

function facts(overrides: Record<string, unknown> = {}) {
  return {
    reservationId: 'r-1',
    status: 'booked',
    startAt: START,
    endAt: END,
    memberUserId: MEMBER,
    seriesId: null,
    cancellationReason: null,
    aircraft: ['N4471K'],
    instructors: ['Casey Reed (CFI)'],
    otherResources: [],
    ...overrides,
  };
}

function context(bookings: unknown[]) {
  return { actorDisplayName: 'Dana Ruiz', orgName: 'Bravo Flying Club', bookings };
}

const NOTICE_HEADER = { timeZone: 'America/Chicago', changedBy: 'Dana Ruiz', orgName: 'Bravo Flying Club' };
const LABELS = { aircraft: ['N4471K'], instructors: ['Casey Reed (CFI)'], otherResources: [] };

/** The 'reservation.for_member' sends, in order. */
function memberNotices() {
  return api.sendNotification.mock.calls
    .map((call) => call[1] as { toUserId: string; eventType: string; templateData: Record<string, unknown> })
    .filter((input) => input.eventType === 'reservation.for_member');
}

let consoleError: { mockRestore: () => void };

beforeEach(() => {
  vi.clearAllMocks();
  actionAuth.mockResolvedValue(session);
  viewerZone.mockResolvedValue('America/Chicago');
  api.sendNotification.mockResolvedValue({ sent: true });
  // A failed notice is logged; keep the test output clean.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

// ════════════════════════════════════════════════════════════════════════════════
// 1. createReservationAction
// ════════════════════════════════════════════════════════════════════════════════

describe('1. createReservationAction', () => {
  const input = { startAt: START, endAt: END, resourceIds: ['res-aircraft', 'res-cfi'], memberUserId: MEMBER };

  it('booked for someone else: the booker keeps their confirmation AND the member is told once', async () => {
    const createResult = { ok: true, reservation: created(MEMBER) };
    api.createReservation.mockResolvedValue(createResult);
    api.getMemberBookingNoticeContext.mockResolvedValue(context([facts()]));

    const result = await createReservationAction(input);

    expect(result).toBe(createResult);
    expect(api.sendNotification).toHaveBeenCalledTimes(2);
    // The booker's existing receipt — unchanged.
    expect(api.sendNotification).toHaveBeenNthCalledWith(1, session, {
      toUserId: STAFF,
      eventType: 'reservation.created',
      templateData: { startAt: START, endAt: END, resourceIds: ['res-aircraft', 'res-cfi'] },
    });
    // The member it is for: labels, never ids; zoned times; who did it.
    expect(api.getMemberBookingNoticeContext).toHaveBeenCalledWith(session, { reservationIds: ['r-1'] });
    expect(api.sendNotification).toHaveBeenNthCalledWith(2, session, {
      toUserId: MEMBER,
      eventType: 'reservation.for_member',
      templateData: { change: 'booked', ...LABELS, startAt: START, endAt: END, ...NOTICE_HEADER },
    });
  });

  it('the recipient is the member read from the row — never the id the request carried', async () => {
    api.createReservation.mockResolvedValue({ ok: true, reservation: created(MEMBER) });
    api.getMemberBookingNoticeContext.mockResolvedValue(context([facts()]));

    await createReservationAction({ ...input, memberUserId: 'someone-the-browser-named' });

    expect(memberNotices().map((n) => n.toUserId)).toEqual([MEMBER]);
  });

  it('booked for themselves: only the booker\'s confirmation; nothing read for a member', async () => {
    api.createReservation.mockResolvedValue({ ok: true, reservation: created(STAFF) });

    await createReservationAction({ ...input, memberUserId: STAFF });

    expect(api.sendNotification).toHaveBeenCalledTimes(1);
    expect(api.sendNotification.mock.calls[0]![1]).toMatchObject({ eventType: 'reservation.created' });
    expect(api.getMemberBookingNoticeContext).not.toHaveBeenCalled();
  });

  it('no member: only the booker\'s confirmation', async () => {
    api.createReservation.mockResolvedValue({ ok: true, reservation: created() });

    await createReservationAction({ startAt: START, endAt: END, resourceIds: ['res-aircraft'] });

    expect(api.sendNotification).toHaveBeenCalledTimes(1);
    expect(memberNotices()).toEqual([]);
    expect(api.getMemberBookingNoticeContext).not.toHaveBeenCalled();
  });

  it('the row turns out to be for the booker: no member e-mail', async () => {
    api.createReservation.mockResolvedValue({ ok: true, reservation: created(MEMBER) });
    api.getMemberBookingNoticeContext.mockResolvedValue(context([facts({ memberUserId: STAFF })]));

    await createReservationAction(input);

    expect(memberNotices()).toEqual([]);
  });

  it('refused (conflict): nobody is told anything', async () => {
    const refused = { ok: false, reason: 'conflict', conflicts: [] };
    api.createReservation.mockResolvedValue(refused);

    expect(await createReservationAction(input)).toBe(refused);
    expect(api.sendNotification).not.toHaveBeenCalled();
    expect(api.getMemberBookingNoticeContext).not.toHaveBeenCalled();
  });

  it('sendNotification rejects: the action still returns the created reservation', async () => {
    const createResult = { ok: true, reservation: created(MEMBER) };
    api.createReservation.mockResolvedValue(createResult);
    api.getMemberBookingNoticeContext.mockResolvedValue(context([facts()]));
    api.sendNotification.mockRejectedValue(new Error('provider outage'));

    expect(await createReservationAction(input)).toBe(createResult);
    // Both sends were attempted; neither failure escaped.
    expect(api.sendNotification).toHaveBeenCalledTimes(2);
  });

  it('the facts read rejects: still ok, and no member e-mail', async () => {
    const createResult = { ok: true, reservation: created(MEMBER) };
    api.createReservation.mockResolvedValue(createResult);
    api.getMemberBookingNoticeContext.mockRejectedValue(new Error('db hiccup'));

    expect(await createReservationAction(input)).toBe(createResult);
    expect(memberNotices()).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2. createSeriesAction
// ════════════════════════════════════════════════════════════════════════════════

describe('2. createSeriesAction — one e-mail per series', () => {
  const week = 7 * 86_400_000;
  /** Tue/Thu at 10:00–11:30 Denver: four created, one skipped on a conflict. */
  const starts = [0, 2, 7, 9].map((d) => new Date(Date.parse('2026-11-17T17:00:00.000Z') + d * 86_400_000));
  const seriesResult = {
    ok: true,
    series: { id: 'series-1', freq: 'weekly', weekdays: [2, 4], status: 'active' },
    occurrences: [
      ...starts.map((s, i) => ({
        index: i,
        startAt: s,
        endAt: new Date(s.getTime() + 90 * 60_000),
        result: 'created',
        reservationId: `occ-${i}`,
      })),
      {
        index: 4,
        startAt: new Date(starts[0]!.getTime() + 2 * week),
        endAt: new Date(starts[0]!.getTime() + 2 * week + 90 * 60_000),
        result: 'skipped',
        reason: 'conflict',
      },
    ],
    truncatedByCap: false,
    skippedLocalDates: [],
    createdCount: 4,
    skippedCount: 1,
  };
  const seriesInput = {
    weekdays: [2, 4],
    intervalWeeks: 1,
    end: { kind: 'count', count: 5 },
    localStartTime: '10:00',
    durationMinutes: 90,
    tz: 'America/Denver',
    resourceIds: ['res-aircraft'],
    memberUserId: MEMBER,
  };
  const seriesContext = {
    actorDisplayName: 'Dana Ruiz',
    orgName: 'Bravo Flying Club',
    series: { id: 'series-1', status: 'active', weekdays: [2, 4], intervalWeeks: 1, timeZone: 'America/Denver' },
    upcoming: starts.map((s, i) =>
      facts({ reservationId: `occ-${i}`, startAt: s, endAt: new Date(s.getTime() + 90 * 60_000), seriesId: 'series-1' }),
    ),
  };

  it('a series for a member: exactly ONE e-mail — count, weekdays, first and last dates, in the series\' zone', async () => {
    api.createSeries.mockResolvedValue(seriesResult);
    api.getMemberSeriesNoticeContext.mockResolvedValue(seriesContext);

    const result = await createSeriesAction(seriesInput);

    expect(result).toBe(seriesResult);
    expect(api.getMemberSeriesNoticeContext).toHaveBeenCalledWith(session, { seriesId: 'series-1' });
    expect(api.sendNotification).toHaveBeenCalledTimes(1);
    expect(memberNotices()).toEqual([
      {
        toUserId: MEMBER,
        eventType: 'reservation.for_member',
        templateData: {
          change: 'booked',
          ...LABELS,
          startAt: starts[0],
          endAt: new Date(starts[0]!.getTime() + 90 * 60_000),
          timeZone: 'America/Denver',
          changedBy: 'Dana Ruiz',
          orgName: 'Bravo Flying Club',
          series: { count: 4, weekdays: [2, 4], intervalWeeks: 1, lastStartAt: starts[3] },
        },
      },
    ]);
  });

  it('no member in the request: nothing read, nothing sent', async () => {
    api.createSeries.mockResolvedValue(seriesResult);

    await createSeriesAction({ ...seriesInput, memberUserId: undefined });

    expect(api.getMemberSeriesNoticeContext).not.toHaveBeenCalled();
    expect(api.sendNotification).not.toHaveBeenCalled();
  });

  it('a series staff booked for themselves: nothing sent', async () => {
    api.createSeries.mockResolvedValue(seriesResult);
    api.getMemberSeriesNoticeContext.mockResolvedValue({
      ...seriesContext,
      upcoming: seriesContext.upcoming.map((b) => ({ ...b, memberUserId: STAFF })),
    });

    await createSeriesAction({ ...seriesInput, memberUserId: STAFF });
    await createSeriesAction(seriesInput); // the request said MEMBER; the rows say STAFF

    expect(api.sendNotification).not.toHaveBeenCalled();
  });

  it('nothing was created (every date skipped): nothing sent', async () => {
    api.createSeries.mockResolvedValue({
      ...seriesResult,
      occurrences: seriesResult.occurrences.map((o) => ({ ...o, result: 'skipped', reservationId: undefined })),
      createdCount: 0,
      skippedCount: 5,
    });

    await createSeriesAction(seriesInput);

    expect(api.sendNotification).not.toHaveBeenCalled();
  });

  it('sendNotification rejects: the action still returns the series result', async () => {
    api.createSeries.mockResolvedValue(seriesResult);
    api.getMemberSeriesNoticeContext.mockResolvedValue(seriesContext);
    api.sendNotification.mockRejectedValue(new Error('provider outage'));

    expect(await createSeriesAction(seriesInput)).toBe(seriesResult);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3. rescheduleAction
// ════════════════════════════════════════════════════════════════════════════════

describe('3. rescheduleAction — moved', () => {
  const moveInput = { reservationId: 'r-1', newStartAt: NEW_START, newEndAt: NEW_END };
  const movedResult = { ok: true, reservation: { ...created(MEMBER, 'r-2'), startAt: NEW_START, endAt: NEW_END } };
  const before = facts({ status: 'cancelled' });
  const after = facts({ reservationId: 'r-2', startAt: NEW_START, endAt: NEW_END });

  it('the member gets the old and the new times', async () => {
    api.rescheduleReservation.mockResolvedValue(movedResult);
    api.getMemberBookingNoticeContext.mockResolvedValue(context([before, after]));

    expect(await rescheduleAction(moveInput)).toBe(movedResult);

    expect(api.getMemberBookingNoticeContext).toHaveBeenCalledWith(session, { reservationIds: ['r-1', 'r-2'] });
    expect(memberNotices()).toEqual([
      {
        toUserId: MEMBER,
        eventType: 'reservation.for_member',
        templateData: {
          change: 'moved',
          ...LABELS,
          startAt: NEW_START,
          endAt: NEW_END,
          previous: { startAt: START, endAt: END },
          ...NOTICE_HEADER,
        },
      },
    ]);
  });

  it('the aircraft changed too: the notice carries the old labels', async () => {
    api.rescheduleReservation.mockResolvedValue(movedResult);
    api.getMemberBookingNoticeContext.mockResolvedValue(context([before, { ...after, aircraft: ['N733RB'] }]));

    await rescheduleAction({ ...moveInput, newResourceIds: ['res-other'] });

    expect(memberNotices()[0]!.templateData).toMatchObject({
      aircraft: ['N733RB'],
      previous: { startAt: START, endAt: END, ...LABELS },
    });
  });

  it('a move that changed nothing the member would see: nothing sent', async () => {
    api.rescheduleReservation.mockResolvedValue(movedResult);
    api.getMemberBookingNoticeContext.mockResolvedValue(
      context([before, { ...after, startAt: START, endAt: END }]),
    );

    await rescheduleAction(moveInput);

    expect(api.sendNotification).not.toHaveBeenCalled();
  });

  it('the mover is the member (staff moving their own booking), or there is no member: nothing read or sent', async () => {
    api.rescheduleReservation.mockResolvedValue({ ok: true, reservation: created(STAFF, 'r-2') });
    await rescheduleAction(moveInput);
    api.rescheduleReservation.mockResolvedValue({ ok: true, reservation: created(undefined, 'r-2') });
    await rescheduleAction(moveInput);

    expect(api.getMemberBookingNoticeContext).not.toHaveBeenCalled();
    expect(api.sendNotification).not.toHaveBeenCalled();
  });

  it('refused (conflict) or not found: nothing read, nothing sent', async () => {
    api.rescheduleReservation.mockResolvedValue({ ok: false, reason: 'conflict', conflicts: [] });
    await rescheduleAction(moveInput);
    api.rescheduleReservation.mockResolvedValue({ ok: false, reason: 'not_found' });
    await rescheduleAction(moveInput);

    expect(api.getMemberBookingNoticeContext).not.toHaveBeenCalled();
    expect(api.sendNotification).not.toHaveBeenCalled();
  });

  it('sendNotification rejects: the move still returns ok', async () => {
    api.rescheduleReservation.mockResolvedValue(movedResult);
    api.getMemberBookingNoticeContext.mockResolvedValue(context([before, after]));
    api.sendNotification.mockRejectedValue(new Error('provider outage'));

    expect(await rescheduleAction(moveInput)).toBe(movedResult);
    expect(api.sendNotification).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4. cancelReservationAction
// ════════════════════════════════════════════════════════════════════════════════

describe('4. cancelReservationAction — cancelled', () => {
  it('the member is told, with the reason; the booking was read BEFORE it was cancelled', async () => {
    api.getMemberBookingNoticeContext.mockResolvedValue(context([facts()]));
    api.cancelReservation.mockResolvedValue({ ok: true });

    const result = await cancelReservationAction({ reservationId: 'r-1', reason: '  Weather  ' });

    expect(result).toEqual({ ok: true });
    expect(api.getMemberBookingNoticeContext).toHaveBeenCalledWith(session, { reservationIds: ['r-1'] });
    expect(api.getMemberBookingNoticeContext.mock.invocationCallOrder[0]!).toBeLessThan(
      api.cancelReservation.mock.invocationCallOrder[0]!,
    );
    expect(memberNotices()).toEqual([
      {
        toUserId: MEMBER,
        eventType: 'reservation.for_member',
        templateData: { change: 'cancelled', ...LABELS, startAt: START, endAt: END, reason: 'Weather', ...NOTICE_HEADER },
      },
    ]);
  });

  it('no reason given: reason null', async () => {
    api.getMemberBookingNoticeContext.mockResolvedValue(context([facts()]));
    api.cancelReservation.mockResolvedValue({ ok: true });

    await cancelReservationAction({ reservationId: 'r-1' });

    expect(memberNotices()[0]!.templateData).toMatchObject({ change: 'cancelled', reason: null });
  });

  it('already cancelled (a repeat cancel is a no-op): nobody is told again', async () => {
    api.getMemberBookingNoticeContext.mockResolvedValue(context([facts({ status: 'cancelled' })]));
    api.cancelReservation.mockResolvedValue({ ok: true });

    expect(await cancelReservationAction({ reservationId: 'r-1' })).toEqual({ ok: true });
    expect(api.sendNotification).not.toHaveBeenCalled();
  });

  it('the canceller is the member, or there is no member: nothing sent', async () => {
    api.cancelReservation.mockResolvedValue({ ok: true });
    api.getMemberBookingNoticeContext.mockResolvedValue(context([facts({ memberUserId: STAFF })]));
    await cancelReservationAction({ reservationId: 'r-1' });
    api.getMemberBookingNoticeContext.mockResolvedValue(context([facts({ memberUserId: null })]));
    await cancelReservationAction({ reservationId: 'r-1' });

    expect(api.sendNotification).not.toHaveBeenCalled();
  });

  it('not found: nothing sent', async () => {
    api.getMemberBookingNoticeContext.mockResolvedValue(context([]));
    api.cancelReservation.mockResolvedValue({ ok: false, reason: 'not_found' });

    expect(await cancelReservationAction({ reservationId: 'r-404' })).toEqual({ ok: false, reason: 'not_found' });
    expect(api.sendNotification).not.toHaveBeenCalled();
  });

  it('the read before the cancel fails: the cancel still runs and returns ok; no e-mail', async () => {
    api.getMemberBookingNoticeContext.mockRejectedValue(new Error('db hiccup'));
    api.cancelReservation.mockResolvedValue({ ok: true });

    expect(await cancelReservationAction({ reservationId: 'r-1' })).toEqual({ ok: true });
    expect(api.cancelReservation).toHaveBeenCalledWith(session, { reservationId: 'r-1' });
    expect(api.sendNotification).not.toHaveBeenCalled();
  });

  it('sendNotification rejects: the cancel still returns ok', async () => {
    api.getMemberBookingNoticeContext.mockResolvedValue(context([facts()]));
    api.cancelReservation.mockResolvedValue({ ok: true });
    api.sendNotification.mockRejectedValue(new Error('provider outage'));

    expect(await cancelReservationAction({ reservationId: 'r-1', reason: 'Weather' })).toEqual({ ok: true });
    expect(api.sendNotification).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5. cancelSeriesAction
// ════════════════════════════════════════════════════════════════════════════════

describe('5. cancelSeriesAction — one e-mail per series', () => {
  const upcoming = [0, 7, 14].map((d) => {
    const s = new Date(START.getTime() + d * 86_400_000);
    return facts({ reservationId: `occ-${d}`, startAt: s, endAt: new Date(s.getTime() + 90 * 60_000), seriesId: 'series-1' });
  });
  const seriesContext = {
    actorDisplayName: 'Dana Ruiz',
    orgName: 'Bravo Flying Club',
    series: { id: 'series-1', status: 'active', weekdays: [1], intervalWeeks: 1, timeZone: 'America/Chicago' },
    upcoming,
  };

  it('the member is told once: how many upcoming bookings, first and last, the reason', async () => {
    api.getMemberSeriesNoticeContext.mockResolvedValue(seriesContext);
    api.cancelSeries.mockResolvedValue({ ok: true, cancelledCount: 3 });

    const result = await cancelSeriesAction({ seriesId: 'series-1', reason: 'Aircraft sold' });

    expect(result).toEqual({ ok: true, cancelledCount: 3 });
    expect(api.getMemberSeriesNoticeContext.mock.invocationCallOrder[0]!).toBeLessThan(
      api.cancelSeries.mock.invocationCallOrder[0]!,
    );
    expect(api.sendNotification).toHaveBeenCalledTimes(1);
    expect(memberNotices()).toEqual([
      {
        toUserId: MEMBER,
        eventType: 'reservation.for_member',
        templateData: {
          change: 'cancelled',
          ...LABELS,
          startAt: START,
          endAt: END,
          reason: 'Aircraft sold',
          ...NOTICE_HEADER,
          series: { count: 3, weekdays: [1], intervalWeeks: 1, lastStartAt: upcoming[2]!.startAt },
        },
      },
    ]);
  });

  it('nothing cancelled (no upcoming bookings) or the series was already cancelled: nothing sent', async () => {
    api.getMemberSeriesNoticeContext.mockResolvedValue(seriesContext);
    api.cancelSeries.mockResolvedValue({ ok: true, cancelledCount: 0 });
    await cancelSeriesAction({ seriesId: 'series-1' });

    api.getMemberSeriesNoticeContext.mockResolvedValue({
      ...seriesContext,
      series: { ...seriesContext.series, status: 'cancelled' },
      upcoming: [],
    });
    await cancelSeriesAction({ seriesId: 'series-1' });

    expect(api.sendNotification).not.toHaveBeenCalled();
  });

  it('sendNotification rejects: the cancel still returns its count', async () => {
    api.getMemberSeriesNoticeContext.mockResolvedValue(seriesContext);
    api.cancelSeries.mockResolvedValue({ ok: true, cancelledCount: 3 });
    api.sendNotification.mockRejectedValue(new Error('provider outage'));

    expect(await cancelSeriesAction({ seriesId: 'series-1' })).toEqual({ ok: true, cancelledCount: 3 });
  });
});
