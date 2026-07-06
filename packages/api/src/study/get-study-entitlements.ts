/**
 * get-study-entitlements.ts — the caller's own AeroStudy entitlements
 * (Slice STUDY-1; design doc §4, P0).
 *
 * Returns { hasAllAccess, unlockedCertCodes, expiresAt } derived from the
 * caller's UNREVOKED study_grant rows. expiresAt = now + 7 days — the
 * client-side cache TTL (a grant cached on-device stops unlocking after it,
 * so revocation propagates offline).
 *
 * SELF-SCOPING (the load-bearing requirement, mirrors getMyAlerts): the
 * subject is ALWAYS session.userId from the verified mobile token. There is
 * NO row-identifying input — a member can NEVER read another member's
 * grants.
 *
 * GUARANTEES:
 *   - requireCapability('app:access') FIRST (held by ALL 8 roles — a grant
 *     is member-facing, students/renters included).
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - ONE query; the fold to EntitlementState is pure (internal.ts).
 *   - Read-only, NOT audited, NO money.
 *   - `now` injected (defaults to new Date()) for deterministic tests.
 *   - SHIPS-BEFORE-MIGRATION: migration 0035 is staged + human-gated; until
 *     a human applies it, the missing relation surfaces as
 *     StudyTablesNotMigratedError (routes map it to HTTP 503).
 *
 * TWO CALLING FORMS:
 *   getStudyEntitlements(session)           — app code; uses getDb().
 *   getStudyEntitlementsWithDb(db, session) — tests; inject pglite client.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { extractRows } from '../db-rows.js';
import {
  mapScopesToEntitlements,
  computeEntitlementsExpiresAt,
  isMissingRelationError,
  StudyTablesNotMigratedError,
} from './internal.js';
import type { StudyEntitlementsResult } from './types.js';

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getStudyEntitlementsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  now: Date = new Date(),
): Promise<StudyEntitlementsResult> {
  // 1. AUTHZ FIRST: app:access is held by ALL 8 roles.
  requireCapability(session, 'app:access');

  try {
    return await withSessionOrgContextWithDb(db, session, async (sess, tx) => {
      // 2. SELF-SCOPED: sess.userId only — NEVER a caller-supplied id.
      //    Org scoping = RLS (org GUC set by withOrgContext); the partial
      //    unique index study_grant_org_user_scope_active_unique covers
      //    exactly this predicate.
      const result = await tx.execute(sql`
        SELECT scope
        FROM study_grant
        WHERE user_id = ${sess.userId}
          AND revoked_at IS NULL
      `);
      const rows = extractRows<{ scope: string }>(result);

      // 3. Pure fold to the EntitlementState shape + the 7-day cache TTL.
      return {
        ...mapScopesToEntitlements(rows.map((r) => r.scope)),
        expiresAt: computeEntitlementsExpiresAt(now),
      };
    });
  } catch (err) {
    if (isMissingRelationError(err)) throw new StudyTablesNotMigratedError();
    throw err;
  }
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * getStudyEntitlements — app code form. Uses getDb() internally.
 *
 * @param session - AppSession (from the verified mobile token claims).
 * @param now     - Reference instant (defaults to new Date(); injected for tests).
 */
export async function getStudyEntitlements(
  session: AppSession | null | undefined,
  now: Date = new Date(),
): Promise<StudyEntitlementsResult> {
  const db = await getDb();
  return _getStudyEntitlementsImpl(db, session, now);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/**
 * getStudyEntitlementsWithDb — test form. Injects a pglite db client.
 */
export async function getStudyEntitlementsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  now: Date = new Date(),
): Promise<StudyEntitlementsResult> {
  return _getStudyEntitlementsImpl(db, session, now);
}
