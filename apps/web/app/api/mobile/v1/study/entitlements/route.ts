/**
 * apps/web/app/api/mobile/v1/study/entitlements/route.ts
 *
 * AeroStudy entitlements read endpoint — GET only, Node runtime
 * (Slice STUDY-1; design doc §4, P0).
 *
 * TRANSPORT ADAPTER: this route contains NO SQL, NO @aeroops/db import,
 * and NO business logic. It delegates entirely to:
 *   - verifyMobileToken       (token verification — in @aeroops/api)
 *   - sessionFromMobileClaims (session construction — in @aeroops/api)
 *   - getStudyEntitlements    (read surface — in @aeroops/api;
 *                              requireCapability('app:access') fires inside —
 *                              held by ALL 8 roles; self-scoped to
 *                              session.userId ONLY, never a caller-supplied id)
 *
 * SECURITY INVARIANTS (ADR-0010, mirrors /api/mobile/v1/alerts):
 *   - org_id is NEVER read from request body, query params, or headers in a
 *     trusted position. It comes ONLY from the verified signed bearer token.
 *   - The subject is ALWAYS session.userId (derived from the token) — there
 *     is no row-identifying input on this route at all, so a caller can
 *     never fetch another member's grants.
 *   - Expired / tampered / foreign-secret tokens → 401.
 *   - org_id ABSENT from the response body.
 *   - No internal error detail returned to the client on 500.
 *   - READ-ONLY, NOT audited, NO money.
 *
 * SHIPS-BEFORE-MIGRATION: migration 0035_study_grant.sql is STAGED +
 * HUMAN-GATED (never auto-run). Until a human applies it, this route
 * returns a clean 503 { error: 'study_tables_not_migrated' } — a
 * deliberate, documented state, not a bug.
 *
 * RESPONSE (200 on success):
 *   { hasAllAccess: boolean, unlockedCertCodes: string[], expiresAt: ISO }
 *   expiresAt = now + 7 days — the AeroStudy on-device cache TTL: a cached
 *   grant stops unlocking after it, so a revoked/lapsed school membership
 *   expires without the app needing to be online at revocation time.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import {
  verifyMobileToken,
  sessionFromMobileClaims,
  getStudyEntitlements,
  StudyTablesNotMigratedError,
  UnauthenticatedError,
  ForbiddenError,
} from '@aeroops/api';
import type { StudyEntitlementsResult } from '@aeroops/api';

export async function GET(request: Request): Promise<NextResponse> {
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

    // 4. Fetch the caller's own entitlements through the gated read.
    //    requireCapability('app:access') + self-scoping fire inside.
    const result: StudyEntitlementsResult = await getStudyEntitlements(session);

    return NextResponse.json(result, { status: 200 });

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
