/**
 * get-my-training.ts — Portal self-scoped training read (Slice P1.1).
 *
 * getMyTraining — returns the CALLER'S OWN enrollments + content-coverage
 * progress for the portal "My training" card.
 *
 * SELF-SCOPING (the load-bearing requirement): the subject is ALWAYS
 * session.userId from the verified JWT. There is NO row-identifying input.
 * The query predicate is hardwired to student_user_id = session.userId — a
 * portal user can NEVER read another member's training.
 *
 * GUARANTEES:
 *   - requireCapability('portal:access') FIRST.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Reads NOT audited (read-only). [VERIFY-T1-B] progress = content coverage.
 *
 * TWO CALLING FORMS:
 *   getMyTraining(session)          — app code; uses getDb() internally.
 *   getMyTrainingWithDb(db, session) — tests; inject pglite client.
 */

import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type { MyEnrollmentRow } from './types.js';
import { readMyTraining } from './internal.js';

async function _getMyTrainingImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<MyEnrollmentRow[]> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'portal:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // SELF-SCOPED: sess.userId only — never a caller-supplied id.
    return readMyTraining(tx, sess.userId);
  });
}

export async function getMyTraining(
  session: AppSession | null | undefined,
): Promise<MyEnrollmentRow[]> {
  const db = await getDb();
  return _getMyTrainingImpl(db, session);
}

export async function getMyTrainingWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<MyEnrollmentRow[]> {
  return _getMyTrainingImpl(db, session);
}
