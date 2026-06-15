/**
 * session.ts — Request-to-context seam for authenticated server-side operations.
 *
 * Provides withSessionOrgContext, which is the bridge between the Auth.js
 * session (obtained by apps/web's `auth()` helper) and the database's
 * withOrgContext (the tenant query choke-point).
 *
 * FRAMEWORK-AGNOSTIC: This file does NOT import anything from 'next-auth'
 * or 'next/server'. The session is accepted as a plain AppSession value
 * which apps/web obtains via its own `auth()` call and passes in.
 *
 * SECURITY INVARIANT:
 *   The orgId used for every tenant query comes ONLY from the verified
 *   session — never from client-supplied request body/params. apps/web's
 *   `auth()` derives the session from the signed+encrypted JWT, so the
 *   orgId is tamper-proof by construction.
 *
 * TWO CALLING FORMS:
 *
 *   1. App code (apps/web server actions / route handlers) — no db argument:
 *
 *       import { auth } from '@/auth';               // apps/web's NextAuth instance
 *       import { withSessionOrgContext } from '@aeroops/api';
 *
 *       export async function myServerAction() {
 *         const session = await auth();
 *         return withSessionOrgContext(session, async (sess, tx) => {
 *           // sess.orgId comes from the signed JWT — tamper-proof.
 *           // tx is scoped to sess.orgId (RLS enforced).
 *           return tx.select().from(someTable).execute();
 *         });
 *       }
 *
 *   2. Test code (inject pglite client directly):
 *
 *       import { withSessionOrgContextWithDb } from '@aeroops/api';
 *
 *       await withSessionOrgContextWithDb(pgliteDb, session, async (sess, tx) => {
 *         ...
 *       });
 *
 * The session parameter accepts `AppSession | null | undefined` so that the
 * raw return value of NextAuth's `auth()` can be passed in without a
 * pre-null-check in every call site. A missing session throws with a clear
 * 'UNAUTHENTICATED' error.
 */
import { withOrgContext } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { getDb } from '../db.js';
import type { AppSession } from './types.js';

// Re-export AppSession so callers only need one import.
export type { AppSession } from './types.js';

// ─── Shared implementation ────────────────────────────────────────────────────

/**
 * _withSessionOrgContextImpl — the shared implementation that accepts an
 * explicit db (either the memoized prod client or a test-injected pglite).
 *
 * INTERNAL — not exported from index.ts. Use withSessionOrgContext (app)
 * or withSessionOrgContextWithDb (tests) from the public surface.
 */
async function _withSessionOrgContextImpl<T>(
  db: AnyDb,
  session: AppSession | null | undefined,
  fn: (session: AppSession, tx: AnyDb) => Promise<T>,
): Promise<T> {
  if (!session || !session.userId || !session.orgId || !session.role) {
    throw new UnauthenticatedError(
      '[withSessionOrgContext] No authenticated session. ' +
        'Ensure the caller has checked auth() before calling this function.',
    );
  }

  return withOrgContext(db, session.orgId, (tx) => fn(session, tx));
}

// ─── App-code form (no db argument — uses getDb() internally) ────────────────

/**
 * withSessionOrgContext — validates the session then runs fn inside
 * withOrgContext scoped to session.orgId.
 *
 * Uses the memoized production DB client (getDb()) — apps/web never needs
 * to import or pass a db client.
 *
 * @param session - The AppSession from NextAuth's `auth()` (may be null/undefined).
 * @param fn      - Callback that receives (session, tx) and returns a Promise<T>.
 * @returns       - Whatever fn returns.
 * @throws        - UnauthenticatedError if session is null/undefined/incomplete.
 */
export async function withSessionOrgContext<T>(
  session: AppSession | null | undefined,
  fn: (session: AppSession, tx: AnyDb) => Promise<T>,
): Promise<T> {
  const db = await getDb();
  return _withSessionOrgContextImpl(db, session, fn);
}

// ─── Test/injectable form (explicit db argument) ──────────────────────────────

/**
 * withSessionOrgContextWithDb — same contract as withSessionOrgContext but
 * accepts an explicit db argument (for test code that injects a pglite client).
 *
 * Tests MUST use this form so they never trigger getDb() (which requires a
 * real DATABASE_URL and a running Postgres instance).
 *
 * @param db      - The Drizzle database client (pglite test client or prod).
 * @param session - The AppSession from NextAuth's `auth()` (may be null/undefined).
 * @param fn      - Callback that receives (session, tx) and returns a Promise<T>.
 * @returns       - Whatever fn returns.
 * @throws        - UnauthenticatedError if session is null/undefined/incomplete.
 */
export async function withSessionOrgContextWithDb<T>(
  db: AnyDb,
  session: AppSession | null | undefined,
  fn: (session: AppSession, tx: AnyDb) => Promise<T>,
): Promise<T> {
  return _withSessionOrgContextImpl(db, session, fn);
}

/**
 * UnauthenticatedError — thrown by withSessionOrgContext when no valid
 * session is present. Callers (apps/web route handlers) should catch this
 * and return a 401 response.
 *
 * Using a named class lets callers do `instanceof UnauthenticatedError`
 * to distinguish auth failures from infrastructure errors.
 */
export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}
