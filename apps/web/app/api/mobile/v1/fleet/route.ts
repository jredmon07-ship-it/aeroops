/**
 * apps/web/app/api/mobile/v1/fleet/route.ts
 *
 * Mobile fleet-list read endpoint — GET only, Node runtime.
 *
 * TRANSPORT ADAPTER: this route contains NO SQL, NO @aeroops/db import,
 * and NO business logic. It delegates entirely to:
 *   - verifyMobileToken       (token verification — in @aeroops/api)
 *   - sessionFromMobileClaims (session construction — in @aeroops/api)
 *   - listAircraft            (read surface — in @aeroops/api, UNCHANGED;
 *                              requireCapability('fleet:access') fires inside)
 *   - toMobileAircraftListDTO (mapper — in @aeroops/core, PURE)
 *
 * SECURITY INVARIANTS (ADR-0010, mirrors /api/mobile/v1/schedule):
 *   - org_id is NEVER read from request body, query params, or headers in a
 *     trusted position. It comes ONLY from the verified signed bearer token
 *     via sessionFromMobileClaims, which derives it from verifyMobileToken.
 *   - Expired / tampered / foreign-secret tokens → 401.
 *   - A role lacking fleet:access → 403 (ForbiddenError from listAircraft).
 *   - org_id ABSENT from the response body (MobileFleetListResponse).
 *   - No internal error detail returned to the client on 500.
 *   - READ-ONLY: no write path here (mobile token is non-revocable for 8h —
 *     [VERIFY-4M-SEC-1] — write surfaces are out of scope for this slice).
 *
 * RESPONSE (200 on success):
 *   MobileFleetListResponse { aircraft: MobileAircraftListDTO[] }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import {
  verifyMobileToken,
  sessionFromMobileClaims,
  listAircraft,
  UnauthenticatedError,
  ForbiddenError,
} from '@aeroops/api';
import { toMobileAircraftListDTO } from '@aeroops/core';
import type { MobileFleetListResponse } from '@aeroops/core';

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
    //    Fail-closed on a garbage role (requireCapability inside listAircraft
    //    will throw UnauthenticatedError below → 401).
    //    org_id comes ONLY from the token claim, never from the request.
    const session = sessionFromMobileClaims(claims);

    // 4. Fetch the fleet list through the EXISTING gated read.
    //    requireCapability('fleet:access') + RLS fire inside listAircraft.
    //    Default (active-only) — no includeInactive query param on this
    //    read-only mobile surface, keeping the response small and thin.
    const rows = await listAircraft(session);

    // 5. Map to DTOs (org_id absent).
    const response: MobileFleetListResponse = {
      aircraft: rows.map(toMobileAircraftListDTO),
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
