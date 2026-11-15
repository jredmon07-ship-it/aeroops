/**
 * all-reports-action.test.ts — getAllReportsAction's training read follows
 * the Training module (reporting/reports/actions.ts).
 *
 * The bug: with Training off (club mode) the Reports page still rendered an
 * empty "Training throughput" section, and still read it. The page now passes
 * includeTraining: false for such an org.
 *
 * COVERAGE:
 *   1. includeTraining: false → getTrainingThroughput is never called and
 *      trainingThroughput is null; every other report is still read
 *   2. No flag (default) or includeTraining: true → read and serialized as
 *      before (Dates → ISO strings)
 *
 * '@aeroops/api', '@/lib/action-auth' and '@/lib/viewer-time-zone' are
 * mocked: no DB, no next-auth, no request cookies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above imports, so the spies must be too.
const { actionAuth, api } = vi.hoisted(() => {
  const range = {
    key: '30d',
    from: new Date('2026-10-16T00:00:00.000Z'),
    to: new Date('2026-11-15T00:00:00.000Z'),
  };
  return {
    actionAuth: vi.fn(),
    api: {
      range,
      getUtilizationTrend: vi.fn(async () => ({
        range,
        granularity: 'day',
        buckets: [],
        totalFlights: 0,
        totalFlightHours: 0,
        avgHoursPerFlight: 0,
      })),
      getHoursByTail: vi.fn(async () => []),
      getAircraftReport: vi.fn(async () => []),
      getReservationsVsFlightsTrend: vi.fn(async () => ({
        range,
        granularity: 'day',
        buckets: [],
        totalReservationsCreated: 0,
        totalFlightsClosed: 0,
      })),
      getTrainingThroughput: vi.fn(async () => ({
        range,
        enrollmentsCreatedInRange: 2,
        enrollmentsCompletedInRange: 1,
        lessonsRecordedInRange: 9,
        activeEnrollmentCount: 4,
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
// next/headers' cookies() only works inside a request: the viewer's zone is stubbed.
vi.mock('@/lib/viewer-time-zone', () => ({ getViewerTimeZone: async () => 'America/Chicago' }));
vi.mock('@aeroops/api', () => ({
  ...api,
  // lib/action-errors-result.ts maps these with instanceof.
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
}));

import { getAllReportsAction } from '../../actions';

const session = { userId: 'u', orgId: 'o', slug: 'bravo', role: 'owner', user: { email: 'owner@example.com' } };

const OTHER_READS = [
  'getUtilizationTrend',
  'getHoursByTail',
  'getAircraftReport',
  'getReservationsVsFlightsTrend',
  'getMaintenanceTrend',
  'getInstructorUtilization',
  'getSquawksReport',
  'getMaintenanceRemindersReport',
  'getCancellationsReport',
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  actionAuth.mockResolvedValue(session);
});

describe('1. Training module off → no training read', () => {
  it('includeTraining: false skips getTrainingThroughput and returns null', async () => {
    const result = await getAllReportsAction({ range: '30d', includeTraining: false });

    expect(api.getTrainingThroughput).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true });
    if (!('ok' in result)) throw new Error('expected ok');
    expect(result.data.trainingThroughput).toBeNull();
  });

  it('every other report is still read once, with the session', async () => {
    await getAllReportsAction({ range: '30d', includeTraining: false });

    for (const read of OTHER_READS) {
      expect(api[read], read).toHaveBeenCalledTimes(1);
      expect(api[read], read).toHaveBeenCalledWith(session, expect.any(Object));
    }
  });
});

describe('2. Training module on → unchanged', () => {
  it('no flag reads training and serializes it (Dates → ISO strings)', async () => {
    const result = await getAllReportsAction({ range: '30d' });

    expect(api.getTrainingThroughput).toHaveBeenCalledTimes(1);
    expect(api.getTrainingThroughput).toHaveBeenCalledWith(session, { range: '30d' });
    if (!('ok' in result)) throw new Error('expected ok');
    expect(result.data.trainingThroughput).toEqual({
      range: {
        key: '30d',
        from: '2026-10-16T00:00:00.000Z',
        to: '2026-11-15T00:00:00.000Z',
      },
      enrollmentsCreatedInRange: 2,
      enrollmentsCompletedInRange: 1,
      lessonsRecordedInRange: 9,
      activeEnrollmentCount: 4,
    });
  });

  it('includeTraining: true is the same as no flag', async () => {
    const result = await getAllReportsAction({ range: '7d', includeTraining: true });

    expect(api.getTrainingThroughput).toHaveBeenCalledWith(session, { range: '7d' });
    if (!('ok' in result)) throw new Error('expected ok');
    expect(result.data.trainingThroughput).not.toBeNull();
  });
});

describe('3. maintenance reminders are due against the viewer\'s day', () => {
  it('passes the viewer\'s calendar day (19:00 CST is still the 15th)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T01:00:00.000Z'));
    try {
      await getAllReportsAction({ range: '30d' });
    } finally {
      vi.useRealTimers();
    }
    expect(api.getMaintenanceRemindersReport).toHaveBeenCalledWith(session, { today: '2026-11-15' });
  });
});
