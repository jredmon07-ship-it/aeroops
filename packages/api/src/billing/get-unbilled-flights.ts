/**
 * get-unbilled-flights.ts — closed flights that have never been turned into a
 * (non-void) invoice: the "revenue you haven't captured yet" list. FSP-parity
 * with its billable-hours monitoring, and the single most useful billing-hygiene
 * report for a club or school — a flown flight with no invoice is money left on
 * the table.
 *
 * A dispatch is UNBILLED when status='closed' AND no invoice with status<>'void'
 * references it. A voided invoice leaves the flight unbilled again (correct — the
 * bill was cancelled). Bucketed by nothing; a flat list ordered newest-first,
 * plus accurate totals (count + operational hours) even when the list is capped.
 *
 * COMPLEMENTS list-invoiceable-dispatch.ts: that is the billing:MANAGE actionable
 * worklist on the billing page (pick a flight, invoice it). This is the
 * billing:ACCESS range-scoped MONITORING view with totals (count + hours) on the
 * reports page — so a view-only role (e.g. accountant) can see uncaptured revenue
 * they can't reach through the manage-gated worklist.
 *
 * AUTHZ: billing:access. READ-ONLY — zero writes, zero audit rows.
 * TENANT ISOLATION: org_id from the session GUC (withSessionOrgContextWithDb) +
 *   RLS backstop on every table — no org_id predicate needed (house convention).
 * [VERIFY] Operational billing hygiene, NOT an accounting/audit statement.
 * [VERIFY-A] flight_time_hours is Hobbs-derived OPERATIONAL time, not billed time.
 *
 * TWO CALLING FORMS:
 *   getUnbilledFlights(session, input)          — app code.
 *   getUnbilledFlightsWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { resolveReportRange } from '../reporting/internal.js';
import type { ReportRangeKey } from '../reporting/internal.js';
import { extractRows } from '../db-rows.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const ReportRangeKeySchema = z.enum(['7d', '30d', '90d', '180d', '365d']).default('90d');
const InputSchema = z.object({ range: ReportRangeKeySchema });

export type GetUnbilledFlightsInput = { range?: ReportRangeKey | string };

// ─── Output types ─────────────────────────────────────────────────────────────

export interface UnbilledFlightRow {
  ticketId: string;
  resourceId: string;
  tailNumber: string;
  /** The dispatched pilot's name, or null if the record is missing one. */
  pilotName: string | null;
  closedAt: Date;
  /** Hobbs-derived operational hours (numeric 10,1). */
  flightTimeHours: number;
}

export interface UnbilledFlightsResult {
  range: { key: ReportRangeKey; from: Date; to: Date };
  /** Newest-first, capped at ROW_CAP rows for display. */
  flights: UnbilledFlightRow[];
  /** TRUE count of unbilled flights in range (may exceed flights.length). */
  totalCount: number;
  /** TRUE Σ of operational hours across ALL unbilled flights, rounded 1dp. */
  totalHours: number;
  /** true when more unbilled flights exist than the returned list holds. */
  truncated: boolean;
}

const ROW_CAP = 100;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetUnbilledFlightsInput,
): Promise<UnbilledFlightsResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:access');

  // 2. Validate range.
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(`Invalid range: ${parsed.error.message}`);
  const rangeKey = parsed.data.range as ReportRangeKey;

  // 3. Resolve window.
  const now = new Date();
  const { from, to } = resolveReportRange(rangeKey, now);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // The shared predicate: closed, in-window, and not covered by a live invoice.
    // Query 1: accurate totals across ALL matches (independent of the list cap).
    const totalsResult = await tx.execute(sql`
      SELECT
        COUNT(*)::int                          AS "totalCount",
        COALESCE(SUM(d.flight_time_hours), 0)  AS "totalHours"
      FROM dispatch_ticket d
      WHERE d.status = 'closed'
        AND d.closed_at >= ${fromIso}::timestamptz
        AND d.closed_at <  ${toIso}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM invoice i
           WHERE i.dispatch_ticket_id = d.id AND i.status <> 'void'
        )
    `);
    const totalsRow = extractRows<{ totalCount: number | string; totalHours: number | string }>(totalsResult)[0];
    const totalCount = Number(totalsRow?.totalCount ?? 0);
    const totalHours = Math.round(Number(totalsRow?.totalHours ?? 0) * 10) / 10;

    // Query 2: the newest-first display list, capped.
    const listResult = await tx.execute(sql`
      SELECT
        d.id                AS "ticketId",
        d.resource_id       AS "resourceId",
        r.tail_number       AS "tailNumber",
        u.full_name         AS "pilotName",
        d.closed_at         AS "closedAt",
        d.flight_time_hours AS "flightTimeHours"
      FROM dispatch_ticket d
      JOIN resource r ON r.id = d.resource_id
      LEFT JOIN app_user u ON u.id = d.pilot_user_id
      WHERE d.status = 'closed'
        AND d.closed_at >= ${fromIso}::timestamptz
        AND d.closed_at <  ${toIso}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM invoice i
           WHERE i.dispatch_ticket_id = d.id AND i.status <> 'void'
        )
      ORDER BY d.closed_at DESC
      LIMIT ${ROW_CAP}
    `);
    const rows = extractRows<{
      ticketId: string;
      resourceId: string;
      tailNumber: string | null;
      pilotName: string | null;
      closedAt: Date | string;
      flightTimeHours: number | string | null;
    }>(listResult);

    const flights: UnbilledFlightRow[] = rows.map((row) => ({
      ticketId: row.ticketId,
      resourceId: row.resourceId,
      tailNumber: row.tailNumber ?? '—',
      pilotName: row.pilotName ?? null,
      closedAt: row.closedAt instanceof Date ? row.closedAt : new Date(row.closedAt),
      flightTimeHours: Number(row.flightTimeHours ?? 0),
    }));

    return {
      range: { key: rangeKey, from, to },
      flights,
      totalCount,
      totalHours,
      truncated: totalCount > flights.length,
    };
  });
}

// ─── App-code form ─────────────────────────────────────────────────────────────

export async function getUnbilledFlights(
  session: AppSession | null | undefined,
  rawInput: GetUnbilledFlightsInput = {},
): Promise<UnbilledFlightsResult> {
  const db = await getDb();
  return _impl(db, session, rawInput);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getUnbilledFlightsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetUnbilledFlightsInput = {},
): Promise<UnbilledFlightsResult> {
  return _impl(db, session, rawInput);
}
