/**
 * upsert-study-progress.ts — upsert the caller's own AeroStudy readiness
 * summary (Slice STUDY-1; design doc §4, P1 write surface).
 *
 * INSERT … ON CONFLICT (org_id, user_id, cert_code) DO UPDATE into
 * study_progress — always the member's LATEST compact summary (readiness
 * fraction, questions-logged count, last-studied instant), never a log.
 *
 * SELF-SCOPING (the load-bearing requirement, mirrors getMyAlerts): the
 * subject is ALWAYS session.userId from the verified mobile token. A member
 * can NEVER write another member's progress row — there is no user input
 * for the subject at all.
 *
 * GUARANTEES:
 *   - requireCapability('app:access') FIRST (held by ALL 8 roles).
 *   - Input is re-validated here via parseStudyProgressInput even though the
 *     route already validated — the data layer never trusts its caller
 *     (throws ValidationError, the repo's standard invalid-input error).
 *   - org_id from session only (withSessionOrgContextWithDb + the RLS
 *     WITH CHECK (org_id = GUC) backstop on the INSERT/UPDATE).
 *   - ONE statement, idempotent: replaying the same payload converges on
 *     the same row (per RELIABILITY standard for record writes).
 *   - Timestamps cross the raw-SQL boundary as ISO strings + ::timestamptz
 *     (postgres-js cannot serialize a JS Date — see d33b4fd).
 *   - COMPLIANCE: student-entered study-app data — NOT an FAA
 *     knowledge-test result or Part 61/141 determination. NO money.
 *   - SHIPS-BEFORE-MIGRATION: migration 0035 is staged + human-gated; until
 *     a human applies it, the missing relation surfaces as
 *     StudyTablesNotMigratedError (routes map it to HTTP 503).
 *
 * TWO CALLING FORMS:
 *   upsertStudyProgress(session, body)           — app code; uses getDb().
 *   upsertStudyProgressWithDb(db, session, body) — tests; inject pglite.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { extractRows } from '../db-rows.js';
import { ValidationError } from '../scheduling/internal.js';
import {
  parseStudyProgressInput,
  isMissingRelationError,
  StudyTablesNotMigratedError,
} from './internal.js';
import type { StudyProgressView } from './types.js';

// ─── Shared implementation ────────────────────────────────────────────────────

async function _upsertStudyProgressImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  body: unknown,
): Promise<StudyProgressView> {
  // 1. AUTHZ FIRST: app:access is held by ALL 8 roles.
  requireCapability(session, 'app:access');

  // 2. VALIDATE the untrusted payload (pure). The route validates too, but
  //    the data layer never trusts its caller.
  const parsed = parseStudyProgressInput(body);
  if (!parsed.ok) {
    throw new ValidationError(`[upsertStudyProgress] ${parsed.error}`);
  }
  const input = parsed.input;

  try {
    return await withSessionOrgContextWithDb(db, session, async (sess, tx) => {
      // 3. SELF-SCOPED upsert: (sess.orgId, sess.userId) only — NEVER a
      //    caller-supplied subject. Conflict target =
      //    study_progress_org_user_cert_unique (migration 0035).
      //    Dates go over as ISO + ::timestamptz (never a raw JS Date).
      const result = await tx.execute(sql`
        INSERT INTO study_progress
          (org_id, user_id, cert_code, readiness_percent, questions_logged, last_studied_at)
        VALUES (
          ${sess.orgId},
          ${sess.userId},
          ${input.certCode},
          ${input.readinessPercent},
          ${input.questionsLogged},
          ${input.lastStudiedAt.toISOString()}::timestamptz
        )
        ON CONFLICT (org_id, user_id, cert_code) DO UPDATE SET
          readiness_percent = EXCLUDED.readiness_percent,
          questions_logged  = EXCLUDED.questions_logged,
          last_studied_at   = EXCLUDED.last_studied_at,
          updated_at        = now()
        RETURNING
          cert_code                     AS "certCode",
          readiness_percent             AS "readinessPercent",
          questions_logged              AS "questionsLogged",
          last_studied_at::text         AS "lastStudiedAt",
          updated_at::text              AS "updatedAt"
      `);
      const rows = extractRows<{
        certCode: string;
        readinessPercent: number | string;
        questionsLogged: number | string;
        lastStudiedAt: string;
        updatedAt: string;
      }>(result);

      const row = rows[0];
      if (!row) {
        // Structurally unreachable (RETURNING on a successful upsert always
        // yields the row) — fail loudly rather than fabricate a view.
        throw new Error('[upsertStudyProgress] upsert returned no row');
      }

      // 4. Normalize driver shapes (numeric comes back as a string).
      return {
        certCode: row.certCode,
        readinessPercent:
          typeof row.readinessPercent === 'string'
            ? parseFloat(row.readinessPercent)
            : row.readinessPercent,
        questionsLogged:
          typeof row.questionsLogged === 'string'
            ? parseInt(row.questionsLogged, 10)
            : row.questionsLogged,
        lastStudiedAt: new Date(row.lastStudiedAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
      };
    });
  } catch (err) {
    if (isMissingRelationError(err)) throw new StudyTablesNotMigratedError();
    throw err;
  }
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * upsertStudyProgress — app code form. Uses getDb() internally.
 *
 * @param session - AppSession (from the verified mobile token claims).
 * @param body    - UNTRUSTED payload (validated internally).
 */
export async function upsertStudyProgress(
  session: AppSession | null | undefined,
  body: unknown,
): Promise<StudyProgressView> {
  const db = await getDb();
  return _upsertStudyProgressImpl(db, session, body);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/**
 * upsertStudyProgressWithDb — test form. Injects a pglite db client.
 */
export async function upsertStudyProgressWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  body: unknown,
): Promise<StudyProgressView> {
  return _upsertStudyProgressImpl(db, session, body);
}
