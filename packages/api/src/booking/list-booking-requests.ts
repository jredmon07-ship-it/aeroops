/**
 * list-booking-requests.ts — Staff booking-request inbox (Slice PB1.2).
 *
 * listBookingRequests — returns booking requests for the session org,
 * filtered by status (default 'new'), newest-first. Also returns per-status
 * counts so the UI can render inbox badges without a second query.
 *
 * GUARANTEES:
 *   - requireCapability('booking:triage') FIRST — before any data access.
 *   - org_id from session ONLY; RLS is the backstop (no explicit org predicate).
 *   - Default status='new'; optional status filter; limit capped at 100.
 *   - Newest-first (created_at DESC) — matches (org_id,status,created_at DESC) index.
 *   - Read-only; NOT audited (no audit_log row per spec).
 *   - Requester fields are projected read-only; never mutated here.
 *   - NO money, NO FAA determination.
 *
 * TWO CALLING FORMS:
 *   listBookingRequests(session, opts?)          — app code (uses getDb()).
 *   listBookingRequestsWithDb(db, session, opts) — tests (inject pglite client).
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';

// ─── Status domain ────────────────────────────────────────────────────────────

export type BookingRequestStatus = 'new' | 'contacted' | 'converted' | 'declined';

// ─── Row type ─────────────────────────────────────────────────────────────────

/**
 * BookingRequestRow — a single booking request as returned by listBookingRequests.
 *
 * Requester fields are projected read-only; staff triage fields may be null
 * until the request has been handled (status='new').
 */
export interface BookingRequestRow {
  id: string;
  status: BookingRequestStatus;
  requesterName: string;
  requesterEmail: string;
  requesterPhone: string | null;
  requestedStart: Date;
  requestedEnd: Date | null;
  aircraftTypePref: string | null;
  message: string | null;
  handledBy: string | null;
  handledAt: Date | null;
  triageNotes: string | null;
  /**
   * PB2.1b (read-only additive): the id of the reservation this request was
   * converted into (NULL unless status='converted' via convertBookingRequest, or
   * if the linked reservation was later hard-deleted → ON DELETE SET NULL). Drives
   * the Converted-tab "View reservation" link.
   */
  convertedReservationId: string | null;
  createdAt: Date;
}

/**
 * BookingRequestStatusCounts — per-status inbox badge summary.
 * Derived in one query alongside the list (no second round-trip).
 */
export interface BookingRequestStatusCounts {
  new: number;
  contacted: number;
  converted: number;
  declined: number;
}

/**
 * ListBookingRequestsResult — the full response from listBookingRequests.
 */
export interface ListBookingRequestsResult {
  rows: BookingRequestRow[];
  counts: BookingRequestStatusCounts;
}

// ─── Options ──────────────────────────────────────────────────────────────────

export interface ListBookingRequestsOptions {
  /** Filter by status. Defaults to 'new'. */
  status?: BookingRequestStatus;
  /** Maximum number of rows to return. Capped at 100. */
  limit?: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _listBookingRequestsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListBookingRequestsOptions,
): Promise<ListBookingRequestsResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'booking:triage');

  const status = opts?.status ?? 'new';
  const limit = Math.min(opts?.limit ?? 50, 100);

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // 2. Fetch rows filtered by status, newest-first, limit-capped.
    // org_id is NOT in the WHERE clause — RLS scopes to the session org.
    const rowsResult = await tx.execute(sql`
      SELECT
        id,
        status,
        requester_name   AS "requesterName",
        requester_email  AS "requesterEmail",
        requester_phone  AS "requesterPhone",
        requested_start  AS "requestedStart",
        requested_end    AS "requestedEnd",
        aircraft_type_pref AS "aircraftTypePref",
        message,
        handled_by       AS "handledBy",
        handled_at       AS "handledAt",
        triage_notes     AS "triageNotes",
        converted_reservation_id AS "convertedReservationId",
        created_at       AS "createdAt"
      FROM booking_request
      WHERE status = ${status}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);

    // 3. Fetch per-status counts (all four statuses, one pass).
    const countsResult = await tx.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'new')       AS "new",
        COUNT(*) FILTER (WHERE status = 'contacted') AS "contacted",
        COUNT(*) FILTER (WHERE status = 'converted') AS "converted",
        COUNT(*) FILTER (WHERE status = 'declined')  AS "declined"
      FROM booking_request
    `);

    const rawRows = (rowsResult.rows ?? rowsResult) as Array<{
      id: string;
      status: string;
      requesterName: string;
      requesterEmail: string;
      requesterPhone: string | null;
      requestedStart: Date | string;
      requestedEnd: Date | string | null;
      aircraftTypePref: string | null;
      message: string | null;
      handledBy: string | null;
      handledAt: Date | string | null;
      triageNotes: string | null;
      convertedReservationId: string | null;
      createdAt: Date | string;
    }>;

    const rows: BookingRequestRow[] = rawRows.map((r) => ({
      id: r.id,
      status: r.status as BookingRequestStatus,
      requesterName: r.requesterName,
      requesterEmail: r.requesterEmail,
      requesterPhone: r.requesterPhone,
      requestedStart: r.requestedStart instanceof Date
        ? r.requestedStart
        : new Date(r.requestedStart),
      requestedEnd: r.requestedEnd == null
        ? null
        : r.requestedEnd instanceof Date
          ? r.requestedEnd
          : new Date(r.requestedEnd),
      aircraftTypePref: r.aircraftTypePref,
      message: r.message,
      handledBy: r.handledBy,
      handledAt: r.handledAt == null
        ? null
        : r.handledAt instanceof Date
          ? r.handledAt
          : new Date(r.handledAt),
      triageNotes: r.triageNotes,
      convertedReservationId: r.convertedReservationId,
      createdAt: r.createdAt instanceof Date
        ? r.createdAt
        : new Date(r.createdAt),
    }));

    const countsRow = ((countsResult.rows ?? countsResult) as Array<{
      new: string | number;
      contacted: string | number;
      converted: string | number;
      declined: string | number;
    }>)[0] ?? { new: 0, contacted: 0, converted: 0, declined: 0 };

    const counts: BookingRequestStatusCounts = {
      new:       Number(countsRow.new),
      contacted: Number(countsRow.contacted),
      converted: Number(countsRow.converted),
      declined:  Number(countsRow.declined),
    };

    return { rows, counts };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * listBookingRequests — staff triage inbox read.
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param opts    - Optional { status?, limit? }. Default status='new', limit 50.
 * @returns       - { rows: BookingRequestRow[], counts: BookingRequestStatusCounts }
 * @throws        - UnauthenticatedError | ForbiddenError.
 */
export async function listBookingRequests(
  session: AppSession | null | undefined,
  opts?: ListBookingRequestsOptions,
): Promise<ListBookingRequestsResult> {
  const db = await getDb();
  return _listBookingRequestsImpl(db, session, opts);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/** listBookingRequestsWithDb — test form; inject a pglite client. */
export async function listBookingRequestsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListBookingRequestsOptions,
): Promise<ListBookingRequestsResult> {
  return _listBookingRequestsImpl(db, session, opts);
}
