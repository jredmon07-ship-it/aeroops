/**
 * dispatch/internal.ts — shared internals for the dispatch write paths.
 *
 * NOT exported from @aeroops/api. Holds:
 *   - isUniqueViolation — robust 23505 detection across driver wrappings
 *     (sibling of isExclusionViolation in scheduling/internal.ts)
 *   - toDispatchTicketView — mapper: DB row → DispatchTicketView
 *     (parses numeric strings → number, timestamps → Date at the API boundary)
 *
 * ADR-0007 §2: a partial-UNIQUE index (resource_id) WHERE (status='open')
 * enforces the one-open-per-aircraft backstop. A concurrent second INSERT
 * raises Postgres SQLSTATE 23505 (unique_violation); this module catches
 * and maps it to the typed 'already_open' refusal (ADR-0004 catch-and-map).
 */

import type { DispatchTicketView } from './types.js';

// ─── 23505 detection — one-open backstop (ADR-0007 §2) ───────────────────────

/**
 * isUniqueViolation — does this thrown error carry Postgres SQLSTATE 23505
 * (unique_violation)?
 *
 * The driver wraps the raw error: Drizzle throws a DrizzleQueryError whose
 * `.cause` is the postgres-js / pglite error carrying `.code === '23505'`.
 * Some paths surface `.code` directly. We walk the cause chain to be robust
 * across both the pglite test driver and the postgres-js prod driver.
 *
 * Mirrors isExclusionViolation in scheduling/internal.ts (same walk, different
 * code — '23505' vs '23P01').
 */
export function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur != null; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

// ─── DB row → DispatchTicketView mapper ──────────────────────────────────────

/**
 * toDispatchTicketView — maps a raw DB row (numeric(10,1) columns are strings
 * from the postgres-js / pglite driver) to the typed DispatchTicketView.
 *
 * NUMERIC COLUMNS: Postgres numeric(10,1) arrives as a string from the driver.
 * We call parseFloat() at this boundary so callers receive JS numbers.
 *
 * TIMESTAMP COLUMNS: Already a Date when using Drizzle ORM select; may be a
 * string when arriving from raw sql`…` execute results. We coerce both.
 *
 * ADR-0007 §1: meters are write-once. The view is read-only from the caller's
 * perspective; no mutation path is exposed here.
 */
export function toDispatchTicketView(row: {
  id: string;
  orgId: string;
  reservationId: string;
  resourceId: string;
  pilotUserId: string;
  status: string;
  hobbsOut: string | number;
  tachOut: string | number;
  hobbsIn: string | number | null;
  tachIn: string | number | null;
  flightTimeHours: string | number | null;
  notes: string | null;
  openedBy: string;
  openedAt: Date | string;
  closedBy: string | null;
  closedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): DispatchTicketView {
  return {
    id: row.id,
    reservationId: row.reservationId,
    resourceId: row.resourceId,
    pilotUserId: row.pilotUserId,
    status: row.status as DispatchTicketView['status'],
    hobbsOut: typeof row.hobbsOut === 'string' ? parseFloat(row.hobbsOut) : row.hobbsOut,
    tachOut: typeof row.tachOut === 'string' ? parseFloat(row.tachOut) : row.tachOut,
    hobbsIn:
      row.hobbsIn == null
        ? null
        : typeof row.hobbsIn === 'string'
          ? parseFloat(row.hobbsIn)
          : row.hobbsIn,
    tachIn:
      row.tachIn == null
        ? null
        : typeof row.tachIn === 'string'
          ? parseFloat(row.tachIn)
          : row.tachIn,
    flightTimeHours:
      row.flightTimeHours == null
        ? null
        : typeof row.flightTimeHours === 'string'
          ? parseFloat(row.flightTimeHours)
          : row.flightTimeHours,
    notes: row.notes,
    openedBy: row.openedBy,
    openedAt: row.openedAt instanceof Date ? row.openedAt : new Date(row.openedAt),
    closedBy: row.closedBy,
    closedAt:
      row.closedAt == null
        ? null
        : row.closedAt instanceof Date
          ? row.closedAt
          : new Date(row.closedAt),
  };
}
