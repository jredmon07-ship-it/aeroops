/**
 * apps/web/app/api/mobile/v1/squawks/route.ts
 *
 * Mobile open-squawks read endpoint — GET only, Node runtime.
 *
 * TRANSPORT ADAPTER: this route contains NO SQL, NO @aeroops/db import,
 * and NO business logic. It delegates entirely to:
 *   - verifyMobileToken       (token verification — in @aeroops/api)
 *   - sessionFromMobileClaims (session construction — in @aeroops/api)
 *   - listSquawks             (read surface — in @aeroops/api, UNCHANGED;
 *                              requireCapability('maintenance:access') fires
 *                              inside; filtered to status='open')
 *   - listAircraft            (read surface — in @aeroops/api, UNCHANGED;
 *                              requireCapability('fleet:access') fires inside)
 *                              — used ONLY to resolve resourceId → tailNumber
 *                              for display, mirroring the web squawks page
 *                              (which pairs listSquawksAction + listResourcesAction
 *                              the same way). Every role holding
 *                              maintenance:access also holds fleet:access
 *                              (owner/manager/dispatcher/cfi/mechanic) so this
 *                              second read never introduces a NEW authz surface.
 *   - toMobileSquawkDTO       (mapper — in @aeroops/core, PURE)
 *
 * SECURITY INVARIANTS (ADR-0010, mirrors /api/mobile/v1/schedule):
 *   - org_id is NEVER read from request body, query params, or headers in a
 *     trusted position. It comes ONLY from the verified signed bearer token.
 *   - Expired / tampered / foreign-secret tokens → 401.
 *   - A role lacking maintenance:access → 403 (ForbiddenError from listSquawks).
 *   - org_id ABSENT from the response body (MobileSquawksResponse).
 *   - No internal error detail returned to the client on 500.
 *   - READ-ONLY: no write path here ([VERIFY-4M-SEC-1]).
 *
 * RESPONSE (200 on success):
 *   MobileSquawksResponse { squawks: MobileSquawkDTO[] }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import {
  verifyMobileToken,
  sessionFromMobileClaims,
  listSquawks,
  listAircraft,
  UnauthenticatedError,
  ForbiddenError,
} from '@aeroops/api';
import { toMobileSquawkDTO } from '@aeroops/core';
import type { MobileSquawksResponse } from '@aeroops/core';

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
    //    org_id comes ONLY from the token claim, never from the request.
    const session = sessionFromMobileClaims(claims);

    // 4. Fetch open squawks + the aircraft set (for the tail-number join)
    //    through the EXISTING gated reads. requireCapability fires inside
    //    both (maintenance:access, fleet:access respectively) + RLS.
    //    includeInactive:true so a squawk on a since-deactivated aircraft
    //    still resolves a tail number instead of falling back to ''.
    const [squawkRows, aircraftRows] = await Promise.all([
      listSquawks(session, { status: 'open' }),
      listAircraft(session, { includeInactive: true }),
    ]);

    const tailByResourceId = new Map(aircraftRows.map((a) => [a.id, a.tailNumber]));

    // 5. Map to DTOs (org_id absent).
    const response: MobileSquawksResponse = {
      squawks: squawkRows.map((s) =>
        toMobileSquawkDTO(s, tailByResourceId.get(s.resourceId) ?? ''),
      ),
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
