/**
 * apps/web/app/api/mobile/v1/fleet/[id]/route.ts
 *
 * Mobile aircraft-detail read endpoint — GET only, Node runtime.
 *
 * TRANSPORT ADAPTER: this route contains NO SQL, NO @aeroops/db import,
 * and NO business logic. It delegates entirely to:
 *   - verifyMobileToken         (token verification — in @aeroops/api)
 *   - sessionFromMobileClaims   (session construction — in @aeroops/api)
 *   - getAircraftDetail         (read surface — in @aeroops/api, UNCHANGED;
 *                                requireCapability('fleet:access') fires inside)
 *   - toMobileAircraftDetailDTO (mapper — in @aeroops/core, PURE)
 *
 * SECURITY INVARIANTS (ADR-0010, mirrors /api/mobile/v1/schedule):
 *   - org_id is NEVER read from request body, query params, path segments,
 *     or headers in a trusted position. It comes ONLY from the verified
 *     signed bearer token via sessionFromMobileClaims.
 *   - The `id` path segment is the ONLY caller-supplied input, and it is
 *     passed straight through to getAircraftDetail, which re-validates
 *     format (throws ValidationError on non-UUID) and RLS-scopes the lookup
 *     (a cross-org or unknown id → ok:false 'not_found' — never a 500, never
 *     a peek). A malformed id is mapped to the SAME 404 as "not visible" so
 *     the response never distinguishes "badly formed" from "not found"
 *     (anti-enumeration, same posture as the login route).
 *   - Expired / tampered / foreign-secret tokens → 401.
 *   - A role lacking fleet:access → 403 (ForbiddenError from getAircraftDetail).
 *   - org_id ABSENT from the response body (MobileFleetDetailResponse).
 *   - No internal error detail returned to the client on 500.
 *   - READ-ONLY: no write path here ([VERIFY-4M-SEC-1]).
 *
 * RESPONSE:
 *   200 { ok: true,  aircraft: MobileAircraftDetailDTO }
 *   404 { ok: false, reason: 'not_found' }  (also surfaced as top-level
 *        { error: 'not_found' } — see below — for a consistent client
 *        401/403/404/500 error-shape story across all mobile routes)
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import {
  verifyMobileToken,
  sessionFromMobileClaims,
  getAircraftDetail,
  UnauthenticatedError,
  ForbiddenError,
} from '@aeroops/api';
import { toMobileAircraftDetailDTO } from '@aeroops/core';
import type { MobileFleetDetailResponse } from '@aeroops/core';

/** Duck-types the @aeroops/api ValidationError without importing the class
 * (ValidationError is not re-exported from the barrel; this mirrors the
 * `isValidationError` helper already used by apps/web/*\/maintenance/actions.ts). */
function isValidationError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'VALIDATION'
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;

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
    //    org_id comes ONLY from the token claim, never from the request.
    const session = sessionFromMobileClaims(claims);

    // 4. Fetch the aircraft detail through the EXISTING gated read.
    //    requireCapability('fleet:access') + RLS fire inside getAircraftDetail.
    let result;
    try {
      result = await getAircraftDetail(session, { resourceId: id });
    } catch (err) {
      if (isValidationError(err)) {
        // Malformed id — collapse to the SAME 404 as "not visible".
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      throw err;
    }

    if (!result.ok) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // 5. Map to DTO (org_id absent).
    const response: MobileFleetDetailResponse = {
      ok: true,
      aircraft: toMobileAircraftDetailDTO(result.aircraft),
    };

    return NextResponse.json(response, { status: 200 });

  } catch (err) {
    // Map known auth/authz errors to their HTTP status codes.
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    // Any other error → 500 with NO internal detail.
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
