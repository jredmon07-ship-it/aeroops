/**
 * create-series.ts — createSeries: bulk-create a recurring reservation series.
 * (SCHED-2b, ADR-0006 §3.1)
 *
 * GUARANTEES:
 *   - authz first: requireCapability('schedule:create_reservation').
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - One shared write path: each occurrence goes through gatedCreateOccurrence
 *     (the same body as single-create). No gate-skipping bespoke INSERT.
 *   - ONE outer tx (GUC set LOCAL once); per-occurrence savepoints via
 *     tx.transaction(). A skipped occurrence rolls back only its savepoint;
 *     the outer tx commits the series row + all created occurrences atomically.
 *   - `now` captured ONCE at request entry; shared by expandRecurrence + all
 *     gatedCreateOccurrence calls so they agree on the time anchor.
 *   - Partial-create is normal: ok:true even when some occurrences skip.
 *   - Zero future occurrences is NOT an error: series row still created.
 *   - Whole-request failures throw (auth/validation); per-occurrence skips
 *     return ok:true with a skip reason in the report.
 *
 * TWO CALLING FORMS:
 *   createSeries(session, input)                         — app code.
 *   createSeriesWithDb(db, session, input, opts?)        — tests; inject pglite.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { reservationSeries, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { expandRecurrence } from '@aeroops/core';
import type { RecurrenceRule, ZonedToUtc } from '@aeroops/core';
import { ValidationError, gatedCreateOccurrence, toIso } from './internal.js';
import type {
  CreateSeriesInput,
  CreateSeriesResult,
  SeriesOccurrenceReport,
  SeriesRow,
} from './types.js';

// ─── Production tz resolver (INJECTED into expandRecurrence) ─────────────────
//
// Implements ZonedToUtc using platform Intl APIs only (no tz library dep).
// Adapted from the test-side makeIntlResolver in recurrence.test.ts.
//
// DST handling (ADR-0006 §2):
//   - spring-forward gap (local time skipped)  → status 'nonexistent'
//   - fall-back (local time occurs twice)       → status 'ambiguous', utcMs = earlier instant
//   - normal                                    → status 'valid'
//
// Cached per tz string so the Intl.DateTimeFormat object is reused across
// the N occurrence resolutions within one createSeries call.

function makeApiZonedToUtcResolver(): ZonedToUtc {
  const fmtCache = new Map<string, Intl.DateTimeFormat>();

  const getFmt = (tz: string): Intl.DateTimeFormat => {
    let f = fmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      fmtCache.set(tz, f);
    }
    return f;
  };

  // Render a UTC instant into local civil parts in `tz`.
  const partsAt = (utcMs: number, tz: string) => {
    const parts = getFmt(tz).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    let hour = get('hour');
    if (hour === 24) hour = 0; // some engines emit 24 for midnight
    return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') };
  };

  // Offset (minutes, UTC = local - offset) at a given UTC instant in `tz`.
  const offsetAt = (utcMs: number, tz: string): number => {
    const p = partsAt(utcMs, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    return Math.round((asUtc - utcMs) / 60_000);
  };

  return ({ year, month, day, hour, minute, tz }) => {
    const targetLocal = Date.UTC(year, month - 1, day, hour, minute);

    // Two probe offsets to find all UTC instants that render back to this local time.
    const off1 = offsetAt(targetLocal, tz);
    const cand1 = targetLocal - off1 * 60_000;
    const off2 = offsetAt(cand1, tz);
    const cand2 = targetLocal - off2 * 60_000;

    const matches = (utcMs: number): boolean => {
      const p = partsAt(utcMs, tz);
      return (
        p.year === year &&
        p.month === month &&
        p.day === day &&
        p.hour === hour &&
        p.minute === minute
      );
    };

    const valid: number[] = [];
    for (const c of [cand1, cand2]) {
      if (matches(c) && !valid.includes(c)) valid.push(c);
    }

    if (valid.length === 0) {
      // Spring-forward gap: this local time does not exist.
      return { utcMs: cand1, status: 'nonexistent' as const };
    }
    if (valid.length >= 2) {
      // Fall-back: ambiguous. Return the EARLIER instant (ADR-0006 §2).
      return { utcMs: Math.min(...valid), status: 'ambiguous' as const };
    }
    return { utcMs: valid[0]!, status: 'valid' as const };
  };
}

// ─── IANA tz validation ────────────────────────────────────────────────────────

/**
 * isValidIanaTz — true iff the Intl subsystem accepts this tz string.
 * Uses Intl.DateTimeFormat constructor; throws on an invalid zone.
 */
function isValidIanaTz(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ─── Input validation schema ──────────────────────────────────────────────────

// RFC-4122 UUID (relaxed, mirrors internal.ts UUID_RE).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** HH:MM time string (24-hour). */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** YYYY-MM-DD date string. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const createSeriesInputSchema = z.object({
  weekdays: z
    .array(z.number().int().min(1).max(7))
    .min(1, { message: 'weekdays must be non-empty' })
    .refine((ws) => ws.length <= 7, { message: 'weekdays: at most 7 elements' }),
  intervalWeeks: z.number().int().min(1, { message: 'intervalWeeks must be >= 1' }),
  end: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('count'),
      count: z.number().int().min(1).max(52),
    }),
    z.object({
      kind: z.literal('until'),
      untilDate: z.string().regex(DATE_RE, { message: 'untilDate must be YYYY-MM-DD' }),
    }),
  ]),
  localStartTime: z
    .string()
    .regex(TIME_RE, { message: 'localStartTime must be HH:MM (24-hour)' }),
  durationMinutes: z.number().int().min(1, { message: 'durationMinutes must be > 0' }),
  tz: z.string().min(1, { message: 'tz is required' }),
  resourceIds: z
    .array(z.string().regex(UUID_RE, { message: 'resourceIds must be UUIDs' }))
    .min(1, { message: 'At least one resourceId is required' }),
  notes: z.string().optional(),
});

// ─── Input parsing ────────────────────────────────────────────────────────────

/**
 * parseCreateSeriesInput — parse + validate raw input; throws ValidationError on failure.
 * Returns a normalized internal shape.
 */
function parseCreateSeriesInput(raw: unknown): CreateSeriesInput & {
  _parsedEnd:
    | { kind: 'count'; count: number }
    | { kind: 'until'; year: number; month: number; day: number };
  _parsedTime: { hour: number; minute: number };
} {
  const parsed = createSeriesInputSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[scheduling] invalid series input: ${first?.message ?? 'unknown'}`,
    );
  }
  const d = parsed.data;

  // Validate IANA tz.
  if (!isValidIanaTz(d.tz)) {
    throw new ValidationError(
      `[scheduling] invalid IANA timezone: '${d.tz}'`,
    );
  }

  // Parse localStartTime → { hour, minute }.
  const [hh, mm] = d.localStartTime.split(':').map(Number);
  const _parsedTime = { hour: hh!, minute: mm! };

  // Parse end.
  let _parsedEnd:
    | { kind: 'count'; count: number }
    | { kind: 'until'; year: number; month: number; day: number };
  if (d.end.kind === 'count') {
    _parsedEnd = { kind: 'count', count: d.end.count };
  } else {
    const parts = d.end.untilDate.split('-').map(Number);
    _parsedEnd = { kind: 'until', year: parts[0]!, month: parts[1]!, day: parts[2]! };
  }

  // De-duplicate resourceIds.
  const seen = new Set<string>();
  const resourceIds: string[] = [];
  for (const id of d.resourceIds) {
    if (!seen.has(id)) { seen.add(id); resourceIds.push(id); }
  }

  return {
    weekdays: d.weekdays,
    intervalWeeks: d.intervalWeeks,
    end: d.end,
    localStartTime: d.localStartTime,
    durationMinutes: d.durationMinutes,
    tz: d.tz,
    resourceIds,
    notes: d.notes,
    _parsedEnd,
    _parsedTime,
  };
}

// ─── Shared implementation ────────────────────────────────────────────────────

interface CreateSeriesOptions {
  /** Injected epoch ms — for deterministic tests. Defaults to Date.now(). */
  now?: number;
}

async function _createSeriesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  opts?: CreateSeriesOptions,
): Promise<CreateSeriesResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'schedule:create_reservation');

  // 2. VALIDATE input. Throws ValidationError on any failure.
  const parsed = parseCreateSeriesInput(input);
  const { _parsedEnd, _parsedTime, resourceIds, durationMinutes, tz, notes, intervalWeeks } = parsed;

  // 3. Capture `now` ONCE. Shared between expand + all gatedCreateOccurrence calls.
  const now = opts?.now ?? Date.now();

  // 4. Build RecurrenceRule and expand (pure, no I/O).
  const resolveZoned: ZonedToUtc = makeApiZonedToUtcResolver();

  const rule: RecurrenceRule = {
    freq: 'weekly',
    weekdays: parsed.weekdays,
    intervalWeeks,
    end:
      _parsedEnd.kind === 'count'
        ? { kind: 'count', count: _parsedEnd.count }
        : {
            kind: 'until',
            untilDate: {
              year: _parsedEnd.year,
              month: _parsedEnd.month,
              day: _parsedEnd.day,
            },
          },
    localStartTime: _parsedTime,
    durationMinutes,
    tz,
  };

  const { occurrences, truncatedByCap, skippedLocalDates } = expandRecurrence(rule, {
    now,
    resolveZoned,
    hardCap: 52,
  });

  // 5. ONE outer tx: INSERT series row + per-occurrence savepoints.
  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 5a. INSERT the reservation_series row.
    // Compose local_start_time string for DB (HH:MM:SS).
    const localStartTimeStr = `${String(_parsedTime.hour).padStart(2, '0')}:${String(_parsedTime.minute).padStart(2, '0')}:00`;

    // Compose end columns.
    let seriesCount: number | null = null;
    let seriesUntilDate: string | null = null;
    let endKind: 'count' | 'until';
    if (_parsedEnd.kind === 'count') {
      endKind = 'count';
      seriesCount = _parsedEnd.count;
    } else {
      endKind = 'until';
      seriesUntilDate = `${String(_parsedEnd.year).padStart(4, '0')}-${String(_parsedEnd.month).padStart(2, '0')}-${String(_parsedEnd.day).padStart(2, '0')}`;
    }

    // Build weekdays as a Postgres smallint[] literal.
    const weekdaysSorted = Array.from(new Set(parsed.weekdays)).sort((a, b) => a - b);
    const weekdaysLiteral = `{${weekdaysSorted.join(',')}}`;

    // Build resource_ids as a Postgres uuid[] literal.
    const resourceIdsLiteral = `{${resourceIds.map((id) => `"${id}"`).join(',')}}`;

    const seriesRows = await tx.execute(sql`
      INSERT INTO reservation_series (
        org_id, freq, weekdays, interval_weeks, end_kind, count, until_date,
        local_start_time, duration_minutes, iana_tz, resource_ids, notes,
        status, created_by
      ) VALUES (
        ${sess.orgId}::uuid,
        'weekly'::"recurrence_freq",
        ${weekdaysLiteral}::smallint[],
        ${intervalWeeks},
        ${endKind}::"recurrence_end_kind",
        ${seriesCount},
        ${seriesUntilDate}::date,
        ${localStartTimeStr}::time,
        ${durationMinutes},
        ${tz},
        ${resourceIdsLiteral}::uuid[],
        ${notes ?? null},
        'active'::"reservation_series_status",
        ${sess.userId}::uuid
      )
      RETURNING id, org_id, freq, weekdays, interval_weeks, end_kind, count,
                until_date, local_start_time, duration_minutes, iana_tz,
                resource_ids, notes, status, created_by, created_at, updated_at
    `);

    const seriesRow = ((seriesRows.rows ?? seriesRows) as unknown as SeriesRow[])[0]!;
    const seriesId = seriesRow.id;

    // 5b. Audit: series.created.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'series.created',
      entityType: 'reservation_series',
      entityId: seriesId,
      metadata: {
        weekdays: weekdaysSorted,
        intervalWeeks,
        endKind,
        count: seriesCount,
        untilDate: seriesUntilDate,
        localStartTime: localStartTimeStr,
        durationMinutes,
        tz,
        resourceIds,
        occurrenceCount: occurrences.length,
        truncatedByCap,
      },
    });

    // 5c. Per-occurrence: run gatedCreateOccurrence inside a SAVEPOINT.
    //     A skip rolls back only the savepoint; the outer tx stays alive.
    const occurrenceReports: SeriesOccurrenceReport[] = [];
    let createdCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < occurrences.length; i++) {
      const occ = occurrences[i]!;
      const startAt = new Date(occ.startUtcMs);
      const endAt = new Date(occ.endUtcMs);

      let report: SeriesOccurrenceReport;

      try {
        // tx.transaction() emits a SAVEPOINT — per ADR-0006 Option B.
        const result = await (tx as AnyDb).transaction(async (sp: AnyDb) => {
          return gatedCreateOccurrence(
            sp,
            sess,
            db,
            { startAt, endAt, resourceIds, notes, seriesId },
            now,
          );
        });

        if (result.ok) {
          createdCount++;
          report = {
            index: i,
            startAt,
            endAt,
            result: 'created',
            reservationId: result.reservation.id,
          };
        } else {
          skippedCount++;
          report = {
            index: i,
            startAt,
            endAt,
            result: 'skipped',
            reason: result.reason,
            ...(result.reason === 'conflict' || result.reason === 'conflict_and_policy'
              ? { conflicts: result.conflicts }
              : {}),
            ...(result.reason === 'policy' || result.reason === 'conflict_and_policy'
              ? { violations: result.violations }
              : {}),
          };
        }
      } catch (err) {
        // A ValidationError from gatedCreateOccurrence (cross-org resource, etc.)
        // should propagate as a whole-request failure (ADR-0006 invariant 9).
        throw err;
      }

      occurrenceReports.push(report);
    }

    // 5d. Build the SeriesRow result shape.
    const seriesResult = buildSeriesRowResult(seriesRow);

    return {
      ok: true as const,
      series: seriesResult,
      occurrences: occurrenceReports,
      truncatedByCap,
      skippedLocalDates,
      createdCount,
      skippedCount,
    };
  });
}

/**
 * buildSeriesRowResult — map the raw DB row to the SeriesRow API shape.
 */
function buildSeriesRowResult(row: SeriesRow): SeriesRow {
  return {
    id: row.id,
    orgId: row.org_id ?? row.orgId,
    freq: row.freq,
    weekdays: row.weekdays,
    intervalWeeks: row.interval_weeks ?? row.intervalWeeks,
    endKind: row.end_kind ?? row.endKind,
    count: row.count ?? null,
    untilDate: row.until_date ?? row.untilDate ?? null,
    localStartTime: row.local_start_time ?? row.localStartTime,
    durationMinutes: row.duration_minutes ?? row.durationMinutes,
    ianaTz: row.iana_tz ?? row.ianaTz,
    resourceIds: row.resource_ids ?? row.resourceIds,
    notes: row.notes ?? null,
    status: row.status,
    createdBy: row.created_by ?? row.createdBy,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * createSeries — expand + create a recurring reservation series for the
 * authenticated org.
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param input   - Series rule (see CreateSeriesInput).
 * @returns CreateSeriesResult — always ok:true (auth/validation throws).
 * @throws  UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function createSeries(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateSeriesResult> {
  const db = await getDb();
  return _createSeriesImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/**
 * createSeriesWithDb — test form; inject a pglite client.
 * `opts.now` accepts an injected epoch-ms clock for deterministic tests.
 */
export async function createSeriesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  opts?: { now?: number },
): Promise<CreateSeriesResult> {
  return _createSeriesImpl(db, session, input, opts);
}
