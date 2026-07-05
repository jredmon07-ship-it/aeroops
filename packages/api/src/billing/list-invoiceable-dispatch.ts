/**
 * list-invoiceable-dispatch.ts — the "flights ready to invoice" worklist.
 *
 * Returns CLOSED dispatch tickets that do NOT yet have a live (non-void) invoice,
 * so the operator can turn a completed flight into a DRAFT invoice with one click
 * (the "the invoice builds itself from the Hobbs reading" flow — the DRAFT is then
 * produced by the existing generateInvoiceFromDispatch command).
 *
 * READ-ONLY. Touches NO dispatch/meter write path and NO money — it simply lists
 * candidates. A ticket with only a 'void' invoice is still invoiceable again.
 *
 * GUARANTEES:
 *   - requireCapability('billing:manage') FIRST (this is an actionable worklist —
 *     only roles that can actually generate an invoice see it; matches the
 *     generateInvoiceFromDispatch gate).
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop). Every
 *     joined table (dispatch_ticket / resource / app_user / invoice) is RLS-scoped.
 *   - No cross-org read possible.
 *
 * TWO CALLING FORMS:
 *   listInvoiceableDispatch(session)          — app code.
 *   listInvoiceableDispatchWithDb(db, session) — tests.
 */
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { extractRows } from '../db-rows.js';

// ─── View type ─────────────────────────────────────────────────────────────────

export interface InvoiceableDispatchRow {
  dispatchTicketId: string;
  resourceId: string;
  tailNumber: string;
  pilotUserId: string;
  /** app_user.full_name when present, else app_user.email. */
  pilotName: string;
  /** Stored flight time (hours) from the closed ticket. */
  flightTimeHours: number | null;
  closedAt: Date | null;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _listInvoiceableDispatchImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<InvoiceableDispatchRow[]> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:manage');

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Closed tickets with NO live (non-void) invoice referencing them.
    // RLS scopes every table to the session org.
    const result = await tx.execute(sql`
      SELECT
        dt.id                AS "dispatchTicketId",
        dt.resource_id       AS "resourceId",
        r.tail_number        AS "tailNumber",
        dt.pilot_user_id     AS "pilotUserId",
        COALESCE(au.full_name, au.email) AS "pilotName",
        dt.flight_time_hours AS "flightTimeHours",
        dt.closed_at         AS "closedAt"
      FROM dispatch_ticket dt
      JOIN resource r  ON r.id  = dt.resource_id
      JOIN app_user au ON au.id = dt.pilot_user_id
      WHERE dt.status = 'closed'
        AND NOT EXISTS (
          SELECT 1 FROM invoice i
          WHERE i.dispatch_ticket_id = dt.id
            AND i.status <> 'void'
        )
      ORDER BY dt.closed_at DESC
    `);

    const rows = extractRows<{
      dispatchTicketId: string;
      resourceId: string;
      tailNumber: string;
      pilotUserId: string;
      pilotName: string;
      flightTimeHours: string | number | null;
      closedAt: Date | string | null;
    }>(result);

    return rows.map((row) => ({
      dispatchTicketId: row.dispatchTicketId,
      resourceId:       row.resourceId,
      tailNumber:       row.tailNumber,
      pilotUserId:      row.pilotUserId,
      pilotName:        row.pilotName,
      flightTimeHours:  row.flightTimeHours != null ? Number(row.flightTimeHours) : null,
      closedAt:         row.closedAt != null ? new Date(row.closedAt) : null,
    }));
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function listInvoiceableDispatch(
  session: AppSession | null | undefined,
): Promise<InvoiceableDispatchRow[]> {
  const db = await getDb();
  return _listInvoiceableDispatchImpl(db, session);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function listInvoiceableDispatchWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<InvoiceableDispatchRow[]> {
  return _listInvoiceableDispatchImpl(db, session);
}
