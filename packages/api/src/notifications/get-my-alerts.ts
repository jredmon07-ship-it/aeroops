/**
 * get-my-alerts.ts — In-app alerts read (Slice N1.1).
 *
 * getMyAlerts(session)          — app code; uses getDb() internally.
 * getMyAlertsWithDb(db, session) — tests; inject pglite client.
 *
 * Returns the caller's OWN derived in-app alerts: upcoming reservations ≤24h
 * and grounded aircraft on any upcoming reservation.
 *
 * SELF-SCOPING (the load-bearing requirement): the subject is ALWAYS
 * session.userId from the verified JWT. There is NO row-identifying input.
 * A user can NEVER derive alerts from another member's rows.
 *
 * GUARANTEES:
 *   - requireCapability('app:access') FIRST (all 8 roles have this).
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - ONE withSessionOrgContextWithDb call; derivation in ≤2 queries.
 *   - Read-only, NOT audited. NO money.
 *   - `now` injected (defaults to new Date()) for deterministic tests.
 *
 * TWO CALLING FORMS:
 *   getMyAlerts(session, now?, timeZone?)           — app code; uses getDb() internally.
 *   getMyAlertsWithDb(db, session, now?, timeZone?) — tests; inject pglite client.
 *
 * timeZone (optional, default UTC) is the viewer's zone: an "Upcoming flight"
 * alert links to /schedule?date=<the flight's start day in that zone>.
 */

import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { deriveMyAlerts } from './internal.js';
import type { MyAlertsResult } from './types.js';

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getMyAlertsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  now: Date = new Date(),
  timeZone?: string,
): Promise<MyAlertsResult> {
  // AUTHZ FIRST: app:access is held by ALL 8 roles (students, renters, staff, etc.)
  requireCapability(session, 'app:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // SELF-SCOPED: sess.userId only — NEVER a caller-supplied id.
    const alerts = await deriveMyAlerts(tx, sess.userId, now, timeZone);
    return { alerts, count: alerts.length };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * getMyAlerts — app code form. Uses getDb() internally.
 *
 * @param session  - AppSession from auth() (may be null/undefined).
 * @param now      - Reference instant (defaults to new Date(); injected for tests).
 * @param timeZone - The viewer's IANA zone: "Upcoming flight" links open the
 *                   schedule on the flight's start day there. Default UTC.
 */
export async function getMyAlerts(
  session: AppSession | null | undefined,
  now: Date = new Date(),
  timeZone?: string,
): Promise<MyAlertsResult> {
  const db = await getDb();
  return _getMyAlertsImpl(db, session, now, timeZone);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/**
 * getMyAlertsWithDb — test form. Injects a pglite db client.
 *
 * @param db       - The Drizzle database client (pglite test client or prod).
 * @param session  - AppSession from auth() (may be null/undefined).
 * @param now      - Reference instant (defaults to new Date(); injected for tests).
 * @param timeZone - The viewer's IANA zone for the links' day. Default UTC.
 */
export async function getMyAlertsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  now: Date = new Date(),
  timeZone?: string,
): Promise<MyAlertsResult> {
  return _getMyAlertsImpl(db, session, now, timeZone);
}
