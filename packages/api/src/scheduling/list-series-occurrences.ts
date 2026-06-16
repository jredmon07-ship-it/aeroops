/**
 * list-series-occurrences.ts — listSeriesOccurrences: read the series row +
 * all its occurrence reservation rows ordered by start_at.
 * (SCHED-2b, ADR-0006 §3.3)
 *
 * GUARANTEES:
 *   - authz: requireCapability('schedule:access').
 *   - org_id from session only (RLS backstop).
 *   - Read-only (no writes, no audit row).
 *   - Series not visible in org → { ok:false, reason:'not_found' }.
 *   - Occurrence rows RLS-scoped; ordered by start_at ascending.
 *
 * TWO CALLING FORMS:
 *   listSeriesOccurrences(session, input)              — app code.
 *   listSeriesOccurrencesWithDb(db, session, input)    — tests; inject pglite.
 */

import { eq, asc, sql } from 'drizzle-orm';
import { reservationSeries, reservation } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type { SeriesRow } from './types.js';
import type { ReservationRow } from './list-reservations.js';

export interface ListSeriesOccurrencesInput {
  seriesId: string;
}

export interface ListSeriesOccurrencesResult {
  ok: true;
  series: SeriesRow;
  occurrences: ReservationRow[];
}

export type ListSeriesOccurrencesResponse =
  | ListSeriesOccurrencesResult
  | { ok: false; reason: 'not_found' };

// ─── Shared implementation ────────────────────────────────────────────────────

async function _listSeriesOccurrencesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: ListSeriesOccurrencesInput,
): Promise<ListSeriesOccurrencesResponse> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'schedule:access');

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // 2. Load the series row (RLS scopes to org).
    const seriesRows = await tx
      .select()
      .from(reservationSeries)
      .where(eq(reservationSeries.id, input.seriesId))
      .limit(1);

    const seriesRaw = seriesRows[0];
    if (!seriesRaw) {
      return { ok: false, reason: 'not_found' };
    }

    // 3. Load occurrence rows (RLS-scoped, ordered by start_at).
    const resvRows = await tx
      .select({
        id: reservation.id,
        orgId: reservation.orgId,
        startAt: reservation.startAt,
        endAt: reservation.endAt,
        status: reservation.status,
        notes: reservation.notes,
        createdBy: reservation.createdBy,
        cancelledAt: reservation.cancelledAt,
        cancelledBy: reservation.cancelledBy,
        seriesId: reservation.seriesId,
      })
      .from(reservation)
      .where(eq(reservation.seriesId, input.seriesId))
      .orderBy(asc(reservation.startAt));

    // 4. Fetch resource join rows for all occurrences in one query.
    const resvIds = resvRows.map((r) => r.id);
    const resourceIdsByReservation = new Map<string, string[]>();

    if (resvIds.length > 0) {
      const idList = sql.join(
        resvIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const joinRows = await tx.execute(sql`
        SELECT reservation_id, resource_id
        FROM reservation_resource
        WHERE reservation_id = ANY(ARRAY[${idList}])
      `);
      const rawJoin = (joinRows.rows ?? joinRows) as Array<{
        reservation_id: string;
        resource_id: string;
      }>;
      for (const j of rawJoin) {
        const existing = resourceIdsByReservation.get(j.reservation_id);
        if (existing) {
          existing.push(j.resource_id);
        } else {
          resourceIdsByReservation.set(j.reservation_id, [j.resource_id]);
        }
      }
    }

    // 5. Assemble ReservationRow[].
    const occurrences: ReservationRow[] = resvRows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      startAt: r.startAt,
      endAt: r.endAt,
      status: r.status as 'booked' | 'cancelled',
      notes: r.notes ?? null,
      createdBy: r.createdBy,
      cancelledAt: r.cancelledAt ?? null,
      cancelledBy: r.cancelledBy ?? null,
      resourceIds: resourceIdsByReservation.get(r.id) ?? [],
    }));

    // 6. Map series row to SeriesRow shape.
    const series: SeriesRow = {
      id: seriesRaw.id,
      orgId: seriesRaw.orgId,
      freq: seriesRaw.freq,
      weekdays: seriesRaw.weekdays ?? [],
      intervalWeeks: seriesRaw.intervalWeeks,
      endKind: seriesRaw.endKind as 'count' | 'until',
      count: seriesRaw.count ?? null,
      untilDate: seriesRaw.untilDate ?? null,
      localStartTime: seriesRaw.localStartTime ?? '',
      durationMinutes: seriesRaw.durationMinutes,
      ianaTz: seriesRaw.ianaTz ?? '',
      resourceIds: seriesRaw.resourceIds ?? [],
      notes: seriesRaw.notes ?? null,
      status: seriesRaw.status as 'active' | 'cancelled',
      createdBy: seriesRaw.createdBy,
      cancelledAt: seriesRaw.cancelledAt ?? null,
      cancelledBy: seriesRaw.cancelledBy ?? null,
      createdAt: seriesRaw.createdAt,
      updatedAt: seriesRaw.updatedAt,
    };

    return { ok: true, series, occurrences };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * listSeriesOccurrences — return the series row + all occurrence reservations.
 *
 * @param session - AppSession; null/undefined → UnauthenticatedError.
 * @param input   - { seriesId }.
 * @returns ListSeriesOccurrencesResponse — ok:true with series+occurrences, or not_found.
 * @throws  UnauthenticatedError | ForbiddenError.
 */
export async function listSeriesOccurrences(
  session: AppSession | null | undefined,
  input: ListSeriesOccurrencesInput,
): Promise<ListSeriesOccurrencesResponse> {
  const db = await getDb();
  return _listSeriesOccurrencesImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/** listSeriesOccurrencesWithDb — test form; inject a pglite client. */
export async function listSeriesOccurrencesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: ListSeriesOccurrencesInput,
): Promise<ListSeriesOccurrencesResponse> {
  return _listSeriesOccurrencesImpl(db, session, input);
}
