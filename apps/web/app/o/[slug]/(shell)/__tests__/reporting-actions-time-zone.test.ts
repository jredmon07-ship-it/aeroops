/**
 * reporting-actions-time-zone.test.ts — the dashboard's range reads count the
 * viewer's days ((shell)/reporting-actions.ts, [VERIFY-R1-TZ]).
 *
 * The bug: the activity chart bucketed by UTC day, so on the UTC-hosted demo a
 * flight closed at 20:00 CST showed on the next day's bar. The KPI, utilization
 * and chart actions now pass the viewer's zone, and each chart bucket carries
 * the local `day` its label is printed from.
 *
 * COVERAGE:
 *   1. The trend, KPI and utilization reads get { range, timeZone }.
 *   2. Chart buckets carry their local day: Chicago 06:00Z → the 15th; Berlin
 *      23:00Z on the 14th → the 15th; no echoed zone → the UTC date.
 *   3. The KPI range keeps the echoed zone; an un-zoned range has no key.
 *
 * '@aeroops/api', '@/lib/action-auth' and '@/lib/viewer-time-zone' are
 * mocked: no DB, no next-auth, no request cookies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { actionAuth, viewerZone, api } = vi.hoisted(() => ({
  actionAuth: vi.fn(),
  viewerZone: vi.fn(async () => 'America/Chicago'),
  api: {
    getOrgDashboardMetrics: vi.fn(),
    getAircraftUtilization: vi.fn(async () => []),
    getReservationsVsFlightsTrend: vi.fn(),
    listReservations: vi.fn(async () => []),
    listAircraft: vi.fn(async () => []),
    listSquawks: vi.fn(async () => []),
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
  getDashboardMetricsAction,
  getAircraftUtilizationAction,
  getReservationsTrendAction,
} from '../reporting-actions';

const session = { userId: 'u', orgId: 'o', slug: 'bravo', role: 'owner', user: { email: 'owner@example.com' } };

function trend(timeZone: string | undefined, starts: string[]) {
  return {
    range: {
      key: '30d',
      from: new Date(starts[0]!),
      to: new Date('2026-11-16T12:00:00.000Z'),
      ...(timeZone !== undefined ? { timeZone } : {}),
    },
    granularity: 'day',
    buckets: starts.map((s, i) => ({
      bucketStart: new Date(s),
      reservationsCreated: i,
      flightsClosed: i + 1,
    })),
    totalReservationsCreated: 1,
    totalFlightsClosed: 3,
  };
}

const metrics = (timeZone?: string) => ({
  range: {
    key: '30d',
    from: new Date('2026-10-18T05:00:00.000Z'),
    to: new Date('2026-11-16T12:00:00.000Z'),
    ...(timeZone !== undefined ? { timeZone } : {}),
  },
  totalFlights: 5,
  totalFlightHours: 5,
  reservationsInRange: 0,
  openSquawkCount: 0,
  groundedAircraftCount: 0,
  activeAircraftCount: 6,
  activeMemberCount: 2,
  openWorkOrderCount: 0,
  activeEnrollmentCount: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  actionAuth.mockResolvedValue(session);
  viewerZone.mockResolvedValue('America/Chicago');
});

describe('1. the range reads get the viewer\'s zone', () => {
  it('activity chart, KPIs and utilization table: { range, timeZone }', async () => {
    api.getReservationsVsFlightsTrend.mockResolvedValue(trend('America/Chicago', ['2026-11-15T06:00:00.000Z']));
    api.getOrgDashboardMetrics.mockResolvedValue(metrics('America/Chicago'));

    await getReservationsTrendAction({ range: '30d' });
    await getDashboardMetricsAction({ range: '7d' });
    await getAircraftUtilizationAction();

    expect(api.getReservationsVsFlightsTrend).toHaveBeenCalledWith(session, { range: '30d', timeZone: 'America/Chicago' });
    expect(api.getOrgDashboardMetrics).toHaveBeenCalledWith(session, { range: '7d', timeZone: 'America/Chicago' });
    expect(api.getAircraftUtilization).toHaveBeenCalledWith(session, { range: '30d', timeZone: 'America/Chicago' });
  });
});

describe('2. chart buckets carry the local day they cover', () => {
  it('Chicago: 06:00Z starts read as their own day (Nov 1 is the 25-hour day)', async () => {
    api.getReservationsVsFlightsTrend.mockResolvedValue(
      trend('America/Chicago', ['2026-11-01T05:00:00.000Z', '2026-11-02T06:00:00.000Z', '2026-11-15T06:00:00.000Z']),
    );
    const result = await getReservationsTrendAction({ range: '30d' });
    if (!('ok' in result)) throw new Error('expected ok');
    expect(result.trend.buckets).toEqual([
      { bucketStart: '2026-11-01T05:00:00.000Z', day: '2026-11-01', reservationsCreated: 0, flightsClosed: 1 },
      { bucketStart: '2026-11-02T06:00:00.000Z', day: '2026-11-02', reservationsCreated: 1, flightsClosed: 2 },
      { bucketStart: '2026-11-15T06:00:00.000Z', day: '2026-11-15', reservationsCreated: 2, flightsClosed: 3 },
    ]);
  });

  it('Berlin: the bucket starting 23:00Z on the 14th is labelled the 15th', async () => {
    viewerZone.mockResolvedValue('Europe/Berlin');
    api.getReservationsVsFlightsTrend.mockResolvedValue(trend('Europe/Berlin', ['2026-11-14T23:00:00.000Z']));
    const result = await getReservationsTrendAction();
    if (!('ok' in result)) throw new Error('expected ok');
    expect(result.trend.buckets[0]?.day).toBe('2026-11-15');
    expect(api.getReservationsVsFlightsTrend).toHaveBeenCalledWith(session, { range: '30d', timeZone: 'Europe/Berlin' });
  });

  it('a read that echoes no zone (rolling UTC buckets) is labelled by UTC date', async () => {
    api.getReservationsVsFlightsTrend.mockResolvedValue(trend(undefined, ['2026-11-16T00:00:00.000Z']));
    const result = await getReservationsTrendAction();
    if (!('ok' in result)) throw new Error('expected ok');
    expect(result.trend.buckets[0]?.day).toBe('2026-11-16');
  });
});

describe('3. the KPI range keeps the zone it was cut in', () => {
  it('a zoned range serializes its timeZone', async () => {
    api.getOrgDashboardMetrics.mockResolvedValue(metrics('America/Chicago'));
    const result = await getDashboardMetricsAction({ range: '30d' });
    if (!('ok' in result)) throw new Error('expected ok');
    expect(result.metrics.range).toEqual({
      key: '30d',
      from: '2026-10-18T05:00:00.000Z',
      to: '2026-11-16T12:00:00.000Z',
      timeZone: 'America/Chicago',
    });
  });

  it('an un-zoned range has no timeZone key', async () => {
    api.getOrgDashboardMetrics.mockResolvedValue(metrics());
    const result = await getDashboardMetricsAction({ range: '30d' });
    if (!('ok' in result)) throw new Error('expected ok');
    expect(Object.keys(result.metrics.range)).toEqual(['key', 'from', 'to']);
  });
});
