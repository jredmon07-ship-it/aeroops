/**
 * preview-series.ts — previewSeries: advisory read-only preview of what
 * createSeries would produce (conflict + policy check, no writes).
 * (SCHED-2b, ADR-0006 §3.4)
 *
 * GUARANTEES:
 *   - authz: requireCapability('schedule:create_reservation') — same gate as
 *     the create it previews.
 *   - PURE PREVIEW: no INSERT/UPDATE/DELETE, no audit row.
 *   - `now` captured ONCE; shared with expandRecurrence so preview agrees with create.
 *   - Uses checkConflicts (conflict probe + policy probe) per occurrence.
 *   - Returns 'would_create' or 'would_skip' per occurrence.
 *
 * NOT A WRITE GATE: advisory only. The authoritative gate is createSeries.
 *
 * TWO CALLING FORMS:
 *   previewSeries(session, input)                        — app code.
 *   previewSeriesWithDb(db, session, input, opts?)       — tests; inject pglite.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { expandRecurrence } from '@aeroops/core';
import type { RecurrenceRule, ZonedToUtc } from '@aeroops/core';
import { ValidationError, runConflictProbe, runPolicyProbe } from './internal.js';
import type { PreviewSeriesResult, PreviewSeriesOccurrenceReport } from './types.js';

// ─── Re-use the same Intl-based tz resolver as create-series ─────────────────

function makeApiZonedToUtcResolver(): ZonedToUtc {
  const fmtCache = new Map<string, Intl.DateTimeFormat>();
  const getFmt = (tz: string): Intl.DateTimeFormat => {
    let f = fmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      fmtCache.set(tz, f);
    }
    return f;
  };
  const partsAt = (utcMs: number, tz: string) => {
    const parts = getFmt(tz).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    let hour = get('hour'); if (hour === 24) hour = 0;
    return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') };
  };
  const offsetAt = (utcMs: number, tz: string): number => {
    const p = partsAt(utcMs, tz);
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - utcMs) / 60_000);
  };
  return ({ year, month, day, hour, minute, tz }) => {
    const targetLocal = Date.UTC(year, month - 1, day, hour, minute);
    const off1 = offsetAt(targetLocal, tz);
    const cand1 = targetLocal - off1 * 60_000;
    const off2 = offsetAt(cand1, tz);
    const cand2 = targetLocal - off2 * 60_000;
    const matches = (utcMs: number): boolean => {
      const p = partsAt(utcMs, tz);
      return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
    };
    const valid: number[] = [];
    for (const c of [cand1, cand2]) { if (matches(c) && !valid.includes(c)) valid.push(c); }
    if (valid.length === 0) return { utcMs: cand1, status: 'nonexistent' as const };
    if (valid.length >= 2) return { utcMs: Math.min(...valid), status: 'ambiguous' as const };
    return { utcMs: valid[0]!, status: 'valid' as const };
  };
}

function isValidIanaTz(tz: string): boolean {
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
}

// ─── Input validation (mirrors create-series) ─────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate and normalize preview input; throws ValidationError on failure. */
function parsePreviewInput(raw: unknown): {
  rule: RecurrenceRule;
  resourceIds: string[];
  notes?: string;
} {
  if (!raw || typeof raw !== 'object') throw new ValidationError('[scheduling] invalid preview input');
  const r = raw as Record<string, unknown>;

  const weekdays = r['weekdays'];
  if (!Array.isArray(weekdays) || weekdays.length === 0) {
    throw new ValidationError('[scheduling] weekdays must be a non-empty array of 1..7');
  }
  for (const w of weekdays) {
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > 7) {
      throw new ValidationError('[scheduling] each weekday must be an integer 1..7');
    }
  }

  const intervalWeeks = r['intervalWeeks'];
  if (typeof intervalWeeks !== 'number' || !Number.isInteger(intervalWeeks) || intervalWeeks < 1) {
    throw new ValidationError('[scheduling] intervalWeeks must be an integer >= 1');
  }

  const end = r['end'];
  if (!end || typeof end !== 'object') throw new ValidationError('[scheduling] end is required');
  const endObj = end as Record<string, unknown>;
  let parsedEnd: RecurrenceRule['end'];
  if (endObj['kind'] === 'count') {
    const count = endObj['count'];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 52) {
      throw new ValidationError('[scheduling] count must be 1..52');
    }
    parsedEnd = { kind: 'count', count };
  } else if (endObj['kind'] === 'until') {
    const untilDate = endObj['untilDate'];
    if (typeof untilDate !== 'string' || !DATE_RE.test(untilDate)) {
      throw new ValidationError('[scheduling] untilDate must be YYYY-MM-DD');
    }
    const parts = untilDate.split('-').map(Number);
    parsedEnd = { kind: 'until', untilDate: { year: parts[0]!, month: parts[1]!, day: parts[2]! } };
  } else {
    throw new ValidationError('[scheduling] end.kind must be count or until');
  }

  const localStartTime = r['localStartTime'];
  if (typeof localStartTime !== 'string' || !TIME_RE.test(localStartTime)) {
    throw new ValidationError('[scheduling] localStartTime must be HH:MM');
  }
  const [hh, mm] = localStartTime.split(':').map(Number);

  const durationMinutes = r['durationMinutes'];
  if (typeof durationMinutes !== 'number' || !Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    throw new ValidationError('[scheduling] durationMinutes must be > 0');
  }

  const tz = r['tz'];
  if (typeof tz !== 'string' || !isValidIanaTz(tz)) {
    throw new ValidationError(`[scheduling] invalid IANA timezone: '${String(tz)}'`);
  }

  const rawResourceIds = r['resourceIds'];
  if (!Array.isArray(rawResourceIds) || rawResourceIds.length === 0) {
    throw new ValidationError('[scheduling] resourceIds must be a non-empty array of UUIDs');
  }
  for (const id of rawResourceIds) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new ValidationError('[scheduling] each resourceId must be a UUID');
    }
  }
  const seen = new Set<string>();
  const resourceIds: string[] = [];
  for (const id of rawResourceIds as string[]) {
    if (!seen.has(id)) { seen.add(id); resourceIds.push(id); }
  }

  const notes = r['notes'];

  const rule: RecurrenceRule = {
    freq: 'weekly',
    weekdays: weekdays as number[],
    intervalWeeks,
    end: parsedEnd,
    localStartTime: { hour: hh!, minute: mm! },
    durationMinutes,
    tz,
  };

  return { rule, resourceIds, notes: typeof notes === 'string' ? notes : undefined };
}

// ─── Shared implementation ────────────────────────────────────────────────────

interface PreviewSeriesOptions {
  now?: number;
}

async function _previewSeriesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  opts?: PreviewSeriesOptions,
): Promise<PreviewSeriesResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'schedule:create_reservation');

  // 2. VALIDATE.
  const { rule, resourceIds } = parsePreviewInput(input);

  // 3. Capture `now` ONCE.
  const now = opts?.now ?? Date.now();

  // 4. Expand.
  const resolveZoned = makeApiZonedToUtcResolver();
  const { occurrences, truncatedByCap, skippedLocalDates } = expandRecurrence(rule, {
    now,
    resolveZoned,
    hardCap: 52,
  });

  // 5. Read-only per-occurrence conflict + policy check.
  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Load resource displayNames for the policy probe (needed for enrichment).
    let resourceMeta: Array<{ id: string; displayName: string }> = [];
    if (resourceIds.length > 0) {
      const idList = sql.join(
        resourceIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const resourceRows = await tx.execute(sql`
        SELECT id, display_name AS display_name
        FROM resource
        WHERE id = ANY(ARRAY[${idList}])
      `);
      const rawResources = (resourceRows.rows ?? resourceRows) as Array<{
        id: string;
        display_name: string;
      }>;
      resourceMeta = rawResources.map((r) => ({ id: r.id, displayName: r.display_name }));
    }

    const reports: PreviewSeriesOccurrenceReport[] = [];
    let wouldCreateCount = 0;
    let wouldSkipCount = 0;

    for (let i = 0; i < occurrences.length; i++) {
      const occ = occurrences[i]!;
      const startAt = new Date(occ.startUtcMs);
      const endAt = new Date(occ.endUtcMs);

      const [hits, violations] = await Promise.all([
        runConflictProbe(tx, startAt, endAt, resourceIds),
        runPolicyProbe(tx, startAt, endAt, resourceMeta, now),
      ]);

      if (hits.length > 0 || violations.length > 0) {
        wouldSkipCount++;
        reports.push({
          index: i,
          startAt,
          endAt,
          result: 'would_skip',
          reason:
            hits.length > 0 && violations.length > 0
              ? 'conflict_and_policy'
              : hits.length > 0
                ? 'conflict'
                : 'policy',
          ...(hits.length > 0 ? { conflicts: hits } : {}),
          ...(violations.length > 0 ? { violations } : {}),
        });
      } else {
        wouldCreateCount++;
        reports.push({
          index: i,
          startAt,
          endAt,
          result: 'would_create',
        });
      }
    }

    return {
      occurrences: reports,
      truncatedByCap,
      skippedLocalDates,
      wouldCreateCount,
      wouldSkipCount,
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * previewSeries — advisory conflict + policy preview for a recurring series.
 * Writes nothing; never the sole write guard.
 *
 * @param session - AppSession; null/undefined → UnauthenticatedError.
 * @param input   - Same shape as createSeries input (Zod-validated here too).
 * @returns PreviewSeriesResult — per-occurrence would_create/would_skip reports.
 * @throws  UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function previewSeries(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<PreviewSeriesResult> {
  const db = await getDb();
  return _previewSeriesImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/** previewSeriesWithDb — test form; inject a pglite client. */
export async function previewSeriesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  opts?: { now?: number },
): Promise<PreviewSeriesResult> {
  return _previewSeriesImpl(db, session, input, opts);
}
