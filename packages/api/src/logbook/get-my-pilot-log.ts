/**
 * logbook/get-my-pilot-log.ts — Portal self-scoped pilot logbook read (Slice P2).
 *
 * getMyPilotLog — the CALLER'S OWN closed dispatch history, newest first,
 * with per-entry derived flight time + a tenths-accurate running total.
 *
 * SELF-SCOPING (the load-bearing requirement): the subject is ALWAYS
 * session.userId from the verified session. There is NO row-identifying
 * input — a portal user can NEVER read another member's log.
 *
 * GUARANTEES:
 *   - requireCapability('portal:access') FIRST.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Reads NOT audited (read-only). NO money.
 *
 * COMPLIANCE HARD LINE: a convenience view of dispatch history — NOT the
 * pilot's official §61.51 logbook of record. See logbook/types.ts.
 *
 * TWO CALLING FORMS:
 *   getMyPilotLog(session, input?)          — app code; uses getDb() internally.
 *   getMyPilotLogWithDb(db, session, input?) — tests; inject pglite client.
 */
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { dateBoundsSchema, readPilotLog, buildPilotLog } from './internal.js';
import type { PilotLog } from './types.js';

export interface GetMyPilotLogInput {
  from?: string;
  to?: string;
}

async function _getMyPilotLogImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<PilotLog> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'portal:access');

  // 2. VALIDATE input.
  const parsed = dateBoundsSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[logbook] invalid getMyPilotLog input: ${first?.message ?? 'unknown'}`);
  }
  const bounds = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // SELF-SCOPED: sess.userId only — never a caller-supplied id.
    const rowsDesc = await readPilotLog(tx, sess.userId, bounds);
    return buildPilotLog(rowsDesc);
  });
}

export async function getMyPilotLog(
  session: AppSession | null | undefined,
  input?: GetMyPilotLogInput,
): Promise<PilotLog> {
  const db = await getDb();
  return _getMyPilotLogImpl(db, session, input);
}

export async function getMyPilotLogWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input?: GetMyPilotLogInput,
): Promise<PilotLog> {
  return _getMyPilotLogImpl(db, session, input);
}
