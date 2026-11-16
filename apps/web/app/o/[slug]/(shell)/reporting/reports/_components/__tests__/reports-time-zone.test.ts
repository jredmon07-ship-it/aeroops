/**
 * reports-time-zone.test.ts — Reports counts the viewer's days
 * (reporting/reports/actions.ts + report-utils.ts, [VERIFY-R1-TZ]).
 *
 * The bug: the trends bucketed by UTC day and every "last N days" was a
 * rolling UTC window, so on the UTC-hosted demo an evening flight sat on the
 * next day. getAllReportsAction now passes the viewer's zone to every range
 * read (one window for every section) and each trend bucket carries the
 * local `day` the page labels and exports.
 *
 * COVERAGE:
 *   1. Every range read gets { range, timeZone }; squawks and reminders keep
 *      their own inputs.
 *   2. Trend buckets carry their local day; the zone stays on the range.
 *   3. formatBucketLabel prints a bucket day as-is (day and week labels).
 *
 * '@aeroops/api', '@/lib/action-auth' and '@/lib/viewer-time-zone' are
 * mocked: no DB, no next-auth, no request cookies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { actionAuth, viewerZone, api } = vi.hoisted(() => {
  const range = {
    key: '30d',
    from: new Date('2026-10-18T05:00:00.000Z'),
    to: new Date('2026-11-16T12:00:00.000Z'),
    timeZone: 'America/Chicago',
  };
  const starts = ['2026-11-01T05:00:00.000Z', '2026-11-15T06:00:00.000Z'];
  return {
    actionAuth: vi.fn(),
    viewerZone: vi.fn(async () => 'America/Chicago'),
    api: {
      getUtilizationTrend: vi.fn(async () => ({
        range,
        granularity: 'day',
        buckets: starts.map((s) => ({ bucketStart: new Date(s), flightCount: 1, flightHours: 1.5 })),
        totalFlights: 2,
        totalFlightHours: 3,
        avgHoursPerFlight: 1.5,
      })),
      getHoursByTail: vi.fn(async () => []),
      getAircraftReport: vi.fn(async () => []),
      getReservationsVsFlightsTrend: vi.fn(async () => ({
        range,
        granularity: 'day',
        buckets: starts.map((s) => ({ bucketStart: new Date(s), reservationsCreated: 1, flightsClosed: 1 })),
        totalReservationsCreated: 2,
        totalFlightsClosed: 2,
      })),
      getTrainingThroughput: vi.fn(async () => ({
        range,
        enrollmentsCreatedInRange: 0,
        enrollmentsCompletedInRange: 0,
        lessonsRecordedInRange: 0,
        activeEnrollmentCount: 0,
      })),
      getMaintenanceTrend: vi.fn(async () => ({
        range,
        squawksOpenedInRange: 0,
        squawksResolvedInRange: 0,
        workOrdersOpenedInRange: 0,
        workOrdersCompletedInRange: 0,
        openSquawkCount: 0,
        groundedAircraftCount: 0,
      })),
      getInstructorUtilization: vi.fn(async () => []),
      getSquawksReport: vi.fn(async () => ({ rows: [], openCount: 0, deferredCount: 0, resolvedCount: 0 })),
      getMaintenanceRemindersReport: vi.fn(async () => ({
        rows: [],
        overdueCount: 0,
        dueSoonCount: 0,
        okCount: 0,
        unknownCount: 0,
      })),
      getCancellationsReport: vi.fn(async () => ({
        range,
        rows: [],
        totalCount: 0,
        lt24hCount: 0,
        d1_7Count: 0,
        gt7dCount: 0,
      })),
    },
  };
});

vi.mock('@/lib/action-auth', () => ({ actionAuth }));
vi.mock('@/lib/viewer-time-zone', () => ({ getViewerTimeZone: viewerZone }));
vi.mock('@aeroops/api', () => ({
  ...api,
  // lib/action-errors-result.ts maps these with instanceof.
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
}));

import { getAllReportsAction } from '../../actions';
import { formatBucketLabel } from '../report-utils';

const session = { userId: 'u', orgId: 'o', slug: 'bravo', role: 'owner', user: { email: 'owner@example.com' } };

const RANGE_READS = [
  'getUtilizationTrend',
  'getHoursByTail',
  'getAircraftReport',
  'getReservationsVsFlightsTrend',
  'getTrainingThroughput',
  'getMaintenanceTrend',
  'getInstructorUtilization',
  'getCancellationsReport',
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  actionAuth.mockResolvedValue(session);
  viewerZone.mockResolvedValue('America/Chicago');
});

describe('1. every range read gets the viewer\'s zone', () => {
  it('one window for every section: { range, timeZone }', async () => {
    await getAllReportsAction({ range: '90d' });
    for (const read of RANGE_READS) {
      expect(api[read], read).toHaveBeenCalledWith(session, { range: '90d', timeZone: 'America/Chicago' });
    }
  });

  it('squawks (no range) and reminders (the viewer\'s today) keep their own inputs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T02:00:00.000Z')); // 20:00 CST on the 15th
    try {
      await getAllReportsAction();
    } finally {
      vi.useRealTimers();
    }
    expect(api.getSquawksReport).toHaveBeenCalledWith(session, {});
    expect(api.getMaintenanceRemindersReport).toHaveBeenCalledWith(session, { today: '2026-11-15' });
  });
});

describe('2. trend buckets carry their local day', () => {
  it('utilization and reservations buckets: day = the Chicago day; the range keeps the zone', async () => {
    const result = await getAllReportsAction({ range: '30d' });
    if (!('ok' in result)) throw new Error('expected ok');
    const { utilizationTrend, reservationsVsFlights, trainingThroughput } = result.data;

    expect(utilizationTrend.buckets.map((b) => [b.bucketStart, b.day])).toEqual([
      ['2026-11-01T05:00:00.000Z', '2026-11-01'],
      ['2026-11-15T06:00:00.000Z', '2026-11-15'],
    ]);
    expect(reservationsVsFlights.buckets.map((b) => b.day)).toEqual(['2026-11-01', '2026-11-15']);
    expect(utilizationTrend.range).toEqual({
      key: '30d',
      from: '2026-10-18T05:00:00.000Z',
      to: '2026-11-16T12:00:00.000Z',
      timeZone: 'America/Chicago',
    });
    expect(trainingThroughput?.range.timeZone).toBe('America/Chicago');
  });
});

describe('3. formatBucketLabel prints a bucket day as given', () => {
  it('day and week labels from "YYYY-MM-DD"', () => {
    expect(formatBucketLabel('2026-11-15', 'day')).toBe('Nov 15');
    expect(formatBucketLabel('2026-11-09', 'week')).toBe('Nov 9–');
    expect(formatBucketLabel('2027-01-01', 'day')).toBe('Jan 1');
  });

  it('a bad day → "—"', () => {
    expect(formatBucketLabel('2026-13-45', 'day')).toBe('—');
  });
});
