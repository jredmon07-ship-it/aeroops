/**
 * apps/web/app/api/mobile/v1/study/progress/route.ts
 *
 * AeroStudy readiness upsert endpoint — POST only, Node runtime
 * (Slice STUDY-1; design doc §4, P1 write surface).
 *
 * TRANSPORT ADAPTER: this route contains NO SQL, NO @aeroops/db import,
 * and NO business logic. It delegates entirely to:
 *   - verifyMobileToken        (token verification — in @aeroops/api)
 *   - sessionFromMobileClaims  (session construction — in @aeroops/api)
 *   - parseStudyProgressInput  (validation — in @aeroops/api, PURE; the
 *                               data layer re-validates: it never trusts
 *                               its caller)
 *   - upsertStudyProgress      (write surface — in @aeroops/api;
 *                               requireCapability('app:access') fires inside —
 *                               held by ALL 8 roles; self-scoped to
 *                               session.userId ONLY: a member can never
 *                               write another member's progress row)
 *
 * SECURITY INVARIANTS (ADR-0010, mirrors /api/mobile/v1/alerts):
 *   - org_id is NEVER read from request body, query params, or headers in a
 *     trusted position. It comes ONLY from the verified signed bearer token.
 *   - The write subject is ALWAYS (session.orgId, session.userId) from the
 *     token — the body carries NO subject-identifying field at all.
 *   - Expired / tampered / foreign-secret tokens → 401.
 *   - Invalid payload → 400 with a field-naming message (and NOTHING else).
 *   - org_id ABSENT from the response body.
 *   - No internal error detail returned to the client on 500.
 *   - Idempotent upsert (ON CONFLICT DO UPDATE) — safe for the offline-first
 *     client to retry. NO money. COMPLIANCE: student-entered study-app
 *     data, NOT an FAA knowledge-test result or Part 61/141 determination.
 *
 * SHIPS-BEFORE-MIGRATION: migration 0035_study_grant.sql is STAGED +
 * HUMAN-GATED (never auto-run). Until a human applies it, this route
 * returns a clean 503 { error: 'study_tables_not_migrated' } — a
 * deliberate, documented state, not a bug.
 *
 * REQUEST:
 *   { certCode: string, readinessPercent: number (0..1),
 *     questionsLogged: int, lastStudiedAt: ISO }
 * RESPONSE (200 on success):
 *   { ok: true, progress: { certCode, readinessPercent, questionsLogged,
 *                           lastStudiedAt, updatedAt } }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import {
  verifyMobileToken,
  sessionFromMobileClaims,
  parseStudyProgressInput,
  upsertStudyProgress,
  StudyTablesNotMigratedError,
  UnauthenticatedError,
  ForbiddenError,
} from '@aeroops/api';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // 1. Extract Bearer token from Authorization header.
    const authHeader = request.headers.get('authorization') ?? '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : null;

    if (!token) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }

    // 2. Verify the token. null → expired / tampered / wrong secret.
    const claims = await verifyMobileToken(token);
    if (!claims) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }

    // 3. Build the session from the verified claims.
    //    org_id / userId come ONLY from the token claim, never from the request.
    const session = sessionFromMobileClaims(claims);

    // 4. Parse + validate the UNTRUSTED body (pure; names the bad field).
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'invalid_request', message: 'body must be valid JSON' },
        { status: 400 },
      );
    }
    const parsed = parseStudyProgressInput(body);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: 'invalid_request', message: parsed.error },
        { status: 400 },
      );
    }

    // 5. Upsert through the gated write. requireCapability('app:access') +
    //    self-scoping + RLS fire inside. Pass the raw body — the data layer
    //    re-validates by contract.
    const progress = await upsertStudyProgress(session, body);

    return NextResponse.json({ ok: true, progress }, { status: 200 });

  } catch (err) {
    // Map known auth/authz errors to their HTTP status codes.
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    // Migration 0035 staged but not applied (human-gated) → clean 503.
    if (err instanceof StudyTablesNotMigratedError) {
      return NextResponse.json(
        { error: 'study_tables_not_migrated' },
        { status: 503 },
      );
    }

    // Any other error → 500 with NO internal detail.
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
