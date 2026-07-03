/**
 * logbook/internal.ts — tx-level helpers for the pilot logbook (Slice P2).
 * NOT exported from @aeroops/api.
 *
 * readPilotLog(tx, userId, bounds) — the one raw-SQL read. Predicate is
 * ALWAYS `pilot_user_id = userId` + `status = 'closed'` (excludes open AND
 * voided tickets). RLS (already ENABLE+FORCE on dispatch_ticket/resource)
 * supplies the org backstop; the caller's withSessionOrgContextWithDb has
 * already set the GUC before this runs.
 *
 * buildPilotLog(rows) — pure aggregation: tenths-integer running totals (no
 * float-sum drift), newest-first entry order (rows arrive DESC from the SQL
 * ORDER BY), grand total.
 *
 * pilotLogToCsvRows / pilotLogCsvFilename — pure CSV projection consumed by
 * the two export commands.
 *
 * COMPLIANCE: reads raw closed-ticket meters — deliberately does NOT apply
 * dispatch_ticket_correction (a convenience view, not a billing read).
 * See [VERIFY-P2-LOG-A] in docs/specs/slice-p2-logbook.md.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AnyDb } from '@aeroops/db';
import { deriveFlightTime, neutralizeCsvFormula } from '@aeroops/core';
import { extractRows } from '../db-rows.js';
import type { PilotLog, PilotLogEntry } from './types.js';

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Date bounds schema ───────────────────────────────────────────────────────

export const dateBoundsSchema = z
  .object({
    from: z.string().datetime().optional(),
    to:   z.string().datetime().optional(),
  })
  .refine((d) => !(d.from && d.to) || d.from <= d.to, {
    message: 'from must be <= to',
  });

export type DateBounds = z.infer<typeof dateBoundsSchema>;

// ─── readPilotLog ─────────────────────────────────────────────────────────────

interface PilotLogRawRow {
  ticketId: string;
  date: Date | string;
  tail: string;
  make: string | null;
  model: string | null;
  hobbsOut: string | number;
  hobbsIn: string | number;
}

function parseNumericCol(v: string | number): number {
  return typeof v === 'string' ? parseFloat(v) : v;
}

/**
 * readPilotLog — closed tickets for `userId`, newest first. `from` is
 * inclusive, `to` is exclusive (half-open `[from, to)`); the UI passes day
 * boundaries. Absent bounds → full history.
 */
export async function readPilotLog(
  tx: AnyDb,
  userId: string,
  bounds: DateBounds,
): Promise<PilotLogEntry[]> {
  const fromClause = bounds.from
    ? sql`AND dt.closed_at >= ${bounds.from}::timestamptz`
    : sql``;
  const toClause = bounds.to
    ? sql`AND dt.closed_at < ${bounds.to}::timestamptz`
    : sql``;

  const result = await tx.execute(sql`
    SELECT dt.id AS "ticketId", dt.closed_at AS "date",
           COALESCE(res.tail_number, res.id::text) AS tail,
           res.make, res.model,
           dt.hobbs_out AS "hobbsOut", dt.hobbs_in AS "hobbsIn"
    FROM dispatch_ticket dt
    JOIN resource res ON res.id = dt.resource_id
    WHERE dt.pilot_user_id = ${userId}::uuid
      AND dt.status = 'closed'
      ${fromClause}
      ${toClause}
    ORDER BY dt.closed_at DESC, dt.id DESC
  `);

  const rows = extractRows<PilotLogRawRow>(result);

  return rows.map((r) => {
    const hobbsOut = parseNumericCol(r.hobbsOut);
    const hobbsIn = parseNumericCol(r.hobbsIn);
    return {
      ticketId: r.ticketId,
      date: r.date instanceof Date ? r.date : new Date(r.date),
      tail: r.tail,
      make: r.make,
      model: r.model,
      hobbsOut,
      hobbsIn,
      flightTimeHours: deriveFlightTime(hobbsOut, hobbsIn),
      runningTotalHours: 0, // filled in by buildPilotLog
    };
  });
}

// ─── buildPilotLog ────────────────────────────────────────────────────────────

/**
 * buildPilotLog — pure aggregation over rows already in DESC (newest-first)
 * order. Running totals accumulate in integer TENTHS while walking ASCENDING
 * (oldest→newest) to avoid float-sum drift, then are attached back onto each
 * entry in the original DESC order. The grand total equals the sum of all
 * entries' flightTimeHours.
 */
export function buildPilotLog(rowsDesc: PilotLogEntry[]): PilotLog {
  if (rowsDesc.length === 0) {
    return { entries: [], totalHours: 0 };
  }

  // Walk oldest→newest (reverse of the DESC input) accumulating tenths.
  const tenthsAtIndex: number[] = new Array(rowsDesc.length);
  let tenths = 0;
  for (let i = rowsDesc.length - 1; i >= 0; i--) {
    tenths += Math.round(rowsDesc[i]!.flightTimeHours * 10);
    tenthsAtIndex[i] = tenths;
  }

  const totalHours = tenths / 10;

  const entries: PilotLogEntry[] = rowsDesc.map((entry, i) => ({
    ...entry,
    runningTotalHours: tenthsAtIndex[i]! / 10,
  }));

  return { entries, totalHours };
}

// ─── pilotLogToCsvRows / pilotLogCsvFilename ──────────────────────────────────

const CSV_HEADER = [
  'Date',
  'Tail',
  'Make',
  'Model',
  'Hobbs Out',
  'Hobbs In',
  'Flight Time (hrs)',
  'Running Total (hrs)',
  'Ticket ID',
];

/** pilotLogToCsvRows — pure CSV projection: header row + one row per entry. */
export function pilotLogToCsvRows(log: PilotLog): string[][] {
  const rows: string[][] = [CSV_HEADER];
  for (const e of log.entries) {
    rows.push([
      e.date.toISOString(),
      neutralizeCsvFormula(e.tail),
      neutralizeCsvFormula(e.make ?? ''),
      neutralizeCsvFormula(e.model ?? ''),
      e.hobbsOut.toFixed(1),
      e.hobbsIn.toFixed(1),
      e.flightTimeHours.toFixed(1),
      e.runningTotalHours.toFixed(1),
      e.ticketId,
    ]);
  }
  return rows;
}

/** pilotLogCsvFilename — deterministic; no PII beyond a date. */
export function pilotLogCsvFilename(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `pilot-logbook-${yyyy}${mm}${dd}.csv`;
}
