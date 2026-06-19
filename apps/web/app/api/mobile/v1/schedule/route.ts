/**
 * apps/web/app/api/mobile/v1/schedule/route.ts
 *
 * Mobile schedule read endpoint — GET only, Node runtime.
 *
 * TRANSPORT ADAPTER: this route contains NO SQL, NO @aeroops/db import,
 * and NO business logic. It delegates entirely to:
 *   - verifyMobileToken      (token verification — in @aeroops/api)
 *   - sessionFromMobileClaims (session construction — in @aeroops/api)
 *   - listReservations       (read surface — in @aeroops/api, UNCHANGED)
 *   - listResources          (read surface — in @aeroops/api, UNCHANGED)
 *   - toMobileReservationDTO (mapper — in @aeroops/core, PURE)
 *   - toMobileResourceDTO    (mapper — in @aeroops/core, PURE)
 *
 * SECURITY INVARIANTS (ADR-0010):
 *   - org_id is NEVER read from request body, query params, or headers in a
 *     trusted position. It comes ONLY from the verified signed bearer token
 *     via sessionFromMobileClaims, which derives it from verifyMobileToken.
 *   - Expired / tampered / foreign-secret tokens → 401 (verifyMobileToken
 *     returns null; this route returns {error:'unauthenticated'}).
 *   - Garbage role in a valid token → sessionFromMobileClaims fail-closed
 *     (session without role field) → requireCapability inside listReservations
 *     throws UnauthenticatedError → 401 here.
 *   - ForbiddenError (role lacks schedule:access) → 403 {error:'forbidden'}.
 *   - org_id ABSENT from the response body (MobileScheduleResponse).
 *   - No internal error detail returned to the client on 500.
 *
 * RESPONSE (200 on success):
 *   MobileScheduleResponse { from, to, reservations: MobileReservationDTO[], resources: MobileResourceDTO[] }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import {
  verifyMobileToken,
  sessionFromMobileClaims,
  listReservations,
  listResources,
  UnauthenticatedError,
  ForbiddenError,
} from '@aeroops/api';
import {
  mobileScheduleWindowSchema,
  toMobileReservationDTO,
  toMobileResourceDTO,
} from '@aeroops/core';
import type { MobileScheduleResponse } from '@aeroops/core';

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
    //    sessionFromMobileClaims is fail-closed: a garbage role yields a session
    //    without a role field, so requireCapability inside listReservations will
    //    throw UnauthenticatedError — caught below → 401.
    //    org_id comes ONLY from the token claim, never from the request.
    const session = sessionFromMobileClaims(claims);

    // 4. Parse and validate the from/to query parameters.
    const url = new URL(request.url);
    const rawFrom = url.searchParams.get('from') ?? '';
    const rawTo   = url.searchParams.get('to')   ?? '';

    const windowParsed = mobileScheduleWindowSchema.safeParse({
      from: rawFrom,
      to:   rawTo,
    });

    if (!windowParsed.success) {
      return NextResponse.json({ error: 'invalid_window' }, { status: 400 });
    }

    const { from: fromStr, to: toStr } = windowParsed.data;
    const fromDate = new Date(fromStr);
    const toDate   = new Date(toStr);

    // 5. Fetch reservations and resources through the EXISTING gated reads.
    //    requireCapability('schedule:access') + RLS fire inside these calls.
    //    Production forms call getDb() internally — this route never imports
    //    @aeroops/db or opens a direct DB connection.
    const [reservationRows, resourceRows] = await Promise.all([
      listReservations(session, { from: fromDate, to: toDate }),
      listResources(session),
    ]);

    // 6. Map to DTOs (org_id absent; Dates → ISO strings).
    const response: MobileScheduleResponse = {
      from: fromStr,
      to:   toStr,
      reservations: reservationRows.map(toMobileReservationDTO),
      resources:    resourceRows.map(toMobileResourceDTO),
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
