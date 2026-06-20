/**
 * get-my-account.ts — Portal self-scoped account read (Slice P1.1).
 *
 * getMyAccount — returns the CALLER'S OWN identity + OWN free-text tags.
 *
 * SELF-SCOPING (the load-bearing requirement): the subject is ALWAYS
 * session.userId from the verified JWT. There is NO row-identifying input.
 * Deliberately a STRICT SUBSET of MemberDetail — it does NOT return status,
 * hasLogin, createdBy, dispatch history, or any other member's data.
 *
 * GUARANTEES:
 *   - requireCapability('portal:access') FIRST.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Reads NOT audited (read-only). [VERIFY-6-A] tags = free-text only.
 *
 * TWO CALLING FORMS:
 *   getMyAccount(session)          — app code; uses getDb() internally.
 *   getMyAccountWithDb(db, session) — tests; inject pglite client.
 */

import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type { MyAccountView } from './types.js';
import { readMyAccount } from './internal.js';

async function _getMyAccountImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<MyAccountView | null> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'portal:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // SELF-SCOPED: sess.userId only — never a caller-supplied id.
    return readMyAccount(tx, sess.userId);
  });
}

export async function getMyAccount(
  session: AppSession | null | undefined,
): Promise<MyAccountView | null> {
  const db = await getDb();
  return _getMyAccountImpl(db, session);
}

export async function getMyAccountWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<MyAccountView | null> {
  return _getMyAccountImpl(db, session);
}
