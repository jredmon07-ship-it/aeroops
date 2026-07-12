/**
 * record-dispatch-service.ts — append a line-ops service event (oil / fuel
 * uplift + note) to a CLOSED dispatch ticket.
 *
 * This is OPERATOR LINE-OPS data (fuel/oil uplift) — NOT a maintenance record,
 * NOT a Part-43/airworthiness determination, NOT a billing instrument. It backs
 * the FC-parity Aircraft report's per-tail Oil Added / Fuel Added columns.
 *
 * RELATION TO THE FROZEN CLOSE PATH:
 *   The FROZEN closeDispatch write path is UNTOUCHED. This command runs as a
 *   SEPARATE, best-effort follow-up AFTER check-in succeeds; it INSERTs one row
 *   into the append-only dispatch_service_log table and NEVER mutates
 *   dispatch_ticket. A re-entry is a NEW row — the latest row per ticket (by
 *   created_at DESC) is the effective service reading (mirrors meter corrections).
 *
 * CAPABILITY: `dispatch:create` — the SAME cap that gates check-in (closeDispatch).
 *   Recording the service performed at check-in is a dispatch-record operation;
 *   the authority that can close a ticket can record its service. Scopes to
 *   owner/manager/dispatcher/cfi (no new capability).
 *
 * GUARANTEES (mirror correctDispatchMeter):
 *   - authz FIRST: `dispatch:create` before any data access.
 *   - Validates input with Zod → ValidationError on malformed data.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Ticket must exist in-org and be CLOSED — returns not_found or not_closed.
 *   - At least one of oilAddedQuarts / fuelAddedGallons / note must be provided.
 *   - One INSERT into dispatch_service_log (append-only; no UPDATE/DELETE).
 *   - One audit row: action 'dispatch.service_recorded'.
 *   - Returns the inserted service row.
 *
 * TWO CALLING FORMS:
 *   recordDispatchService(session, input)          — app code.
 *   recordDispatchServiceWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { eq, inArray, sql } from 'drizzle-orm';
import { dispatchTicket, dispatchServiceLog, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Value schemas (match dispatch_service_log column bounds) ─────────────────

const oilSchema = z
  .number({ message: 'Oil added must be a number' })
  .finite({ message: 'Oil added must be finite' })
  .min(0, { message: 'Oil added must be >= 0' })
  .max(99, { message: 'Oil added must be <= 99 quarts' })
  .refine(
    (v) => Math.round(v * 10) === v * 10,
    { message: 'Oil added must have at most 1 decimal place' },
  );

const fuelSchema = z
  .number({ message: 'Fuel added must be a number' })
  .finite({ message: 'Fuel added must be finite' })
  .min(0, { message: 'Fuel added must be >= 0' })
  .max(999, { message: 'Fuel added must be <= 999 gallons' })
  .refine(
    (v) => Math.round(v * 10) === v * 10,
    { message: 'Fuel added must have at most 1 decimal place' },
  );

// ─── Input schema ─────────────────────────────────────────────────────────────

const recordDispatchServiceInputSchema = z
  .object({
    dispatchTicketId: z.string().regex(UUID_RE, { message: 'dispatchTicketId must be a UUID' }),
    oilAddedQuarts:   oilSchema.optional(),
    fuelAddedGallons: fuelSchema.optional(),
    note:             z.string().trim().max(500, { message: 'note must be <= 500 characters' }).optional(),
  })
  .refine(
    (d) =>
      d.oilAddedQuarts !== undefined ||
      d.fuelAddedGallons !== undefined ||
      (d.note !== undefined && d.note.length > 0),
    { message: 'Record at least one of oil added, fuel added, or a note' },
  );

export type RecordDispatchServiceInput = z.infer<typeof recordDispatchServiceInputSchema>;

// ─── Result types ─────────────────────────────────────────────────────────────

export interface DispatchServiceView {
  id:               string;
  orgId:            string;
  dispatchTicketId: string;
  oilAddedQuarts:   number | null;
  fuelAddedGallons: number | null;
  note:             string | null;
  createdBy:        string;
  createdAt:        Date;
}

export type RecordDispatchServiceResult =
  | { ok: true;  service: DispatchServiceView }
  | { ok: false; reason: 'not_found' | 'not_closed' };

// ─── Internal helper ──────────────────────────────────────────────────────────

function parseNumericCol(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _recordDispatchServiceImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<RecordDispatchServiceResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'dispatch:create');

  // 2. VALIDATE input.
  const parsed = recordDispatchServiceInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[dispatch] invalid recordDispatchService input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { dispatchTicketId, oilAddedQuarts, fuelAddedGallons } = parsed.data;
  // Normalize an all-whitespace / empty note to null (belt-and-suspenders
  // beyond the zod trim; keeps the at-least-one CHECK honest at the DB layer).
  const note = parsed.data.note && parsed.data.note.length > 0 ? parsed.data.note : null;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load ticket (RLS scopes to org; not visible → not_found).
    const ticketRows = await tx
      .select({
        id:     dispatchTicket.id,
        status: dispatchTicket.status,
      })
      .from(dispatchTicket)
      .where(eq(dispatchTicket.id, dispatchTicketId))
      .limit(1);

    const ticket = ticketRows[0];
    if (!ticket) {
      return { ok: false, reason: 'not_found' } as const;
    }
    if (ticket.status !== 'closed') {
      return { ok: false, reason: 'not_closed' } as const;
    }

    // 4. INSERT service row (append-only; no UPDATE/DELETE on this table).
    const inserted = await tx
      .insert(dispatchServiceLog)
      .values({
        orgId:            sess.orgId,
        dispatchTicketId,
        oilAddedQuarts:   oilAddedQuarts   !== undefined ? oilAddedQuarts.toFixed(1)   : null,
        fuelAddedGallons: fuelAddedGallons !== undefined ? fuelAddedGallons.toFixed(1) : null,
        note,
        createdBy:        sess.userId,
        // createdAt defaults via defaultNow() in schema
      })
      .returning();

    const row = inserted[0];
    if (!row) {
      throw new Error('[dispatch] recordDispatchService: INSERT returned no rows');
    }

    // 5. Audit row — one per service event (records integrity).
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'dispatch.service_recorded',
      entityType:  'dispatch_ticket',
      entityId:    dispatchTicketId,
      metadata: {
        serviceLogId:     row.id,
        oilAddedQuarts:   oilAddedQuarts   ?? null,
        fuelAddedGallons: fuelAddedGallons ?? null,
        note,
      },
    });

    // 6. Build the view.
    const view: DispatchServiceView = {
      id:               row.id,
      orgId:            row.orgId,
      dispatchTicketId: row.dispatchTicketId,
      oilAddedQuarts:   parseNumericCol(row.oilAddedQuarts),
      fuelAddedGallons: parseNumericCol(row.fuelAddedGallons),
      note:             row.note,
      createdBy:        row.createdBy,
      createdAt:        row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as string),
    };

    return { ok: true, service: view };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function recordDispatchService(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<RecordDispatchServiceResult> {
  const db = await getDb();
  return _recordDispatchServiceImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function recordDispatchServiceWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<RecordDispatchServiceResult> {
  return _recordDispatchServiceImpl(db, session, input);
}

// ═══════════════════════════════════════════════════════════════════════════════
// READ HELPER — effective (latest) service per ticket
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * getDispatchServiceForTickets — the EFFECTIVE (latest) service reading for each
 * of the given dispatch ticket ids, keyed by ticket id.
 *
 * "Latest" = the row with the greatest created_at per dispatch_ticket_id
 * (DISTINCT ON). Tickets with no service log do not appear in the map (the
 * caller treats absence as "no service recorded").
 *
 * AUTHZ: `dispatch:access` — a read of dispatch records (broader than the
 *   write cap; matches the board/report reads). RLS scopes to session.orgId.
 *
 * TWO CALLING FORMS:
 *   getDispatchServiceForTickets(session, ids)          — app code.
 *   getDispatchServiceForTicketsWithDb(db, session, ids) — tests / the report.
 */
async function _getDispatchServiceForTicketsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  ticketIds: string[],
): Promise<Map<string, DispatchServiceView>> {
  requireCapability(session, 'dispatch:access');

  const ids = ticketIds.filter((id) => UUID_RE.test(id));
  const out = new Map<string, DispatchServiceView>();
  if (ids.length === 0) return out;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // DISTINCT ON (dispatch_ticket_id) ordered by created_at DESC → latest row
    // per ticket. RLS scopes dispatch_service_log to the session org (no
    // org_id predicate needed — the GUC filters before the query evaluates).
    const rows = await tx
      .select({
        id:               dispatchServiceLog.id,
        orgId:            dispatchServiceLog.orgId,
        dispatchTicketId: dispatchServiceLog.dispatchTicketId,
        oilAddedQuarts:   dispatchServiceLog.oilAddedQuarts,
        fuelAddedGallons: dispatchServiceLog.fuelAddedGallons,
        note:             dispatchServiceLog.note,
        createdBy:        dispatchServiceLog.createdBy,
        createdAt:        dispatchServiceLog.createdAt,
      })
      .from(dispatchServiceLog)
      .where(inArray(dispatchServiceLog.dispatchTicketId, ids))
      .orderBy(
        dispatchServiceLog.dispatchTicketId,
        sql`${dispatchServiceLog.createdAt} DESC`,
      );

    // First row seen per ticket is the latest (rows are grouped by ticket id
    // then created_at DESC). Keep the first, skip the rest.
    for (const row of rows) {
      if (out.has(row.dispatchTicketId)) continue;
      out.set(row.dispatchTicketId, {
        id:               row.id,
        orgId:            row.orgId,
        dispatchTicketId: row.dispatchTicketId,
        oilAddedQuarts:   parseNumericCol(row.oilAddedQuarts),
        fuelAddedGallons: parseNumericCol(row.fuelAddedGallons),
        note:             row.note,
        createdBy:        row.createdBy,
        createdAt:        row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as string),
      });
    }

    return out;
  });
}

export async function getDispatchServiceForTickets(
  session: AppSession | null | undefined,
  ticketIds: string[],
): Promise<Map<string, DispatchServiceView>> {
  const db = await getDb();
  return _getDispatchServiceForTicketsImpl(db, session, ticketIds);
}

export async function getDispatchServiceForTicketsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  ticketIds: string[],
): Promise<Map<string, DispatchServiceView>> {
  return _getDispatchServiceForTicketsImpl(db, session, ticketIds);
}
