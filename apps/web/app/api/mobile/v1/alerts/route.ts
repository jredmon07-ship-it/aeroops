/**
 * apps/web/app/api/mobile/v1/alerts/route.ts
 *
 * Mobile in-app alerts read endpoint — GET only, Node runtime.
 *
 * TRANSPORT ADAPTER: this route contains NO SQL, NO @aeroops/db import,
 * and NO business logic. It delegates entirely to:
 *   - verifyMobileToken       (token verification — in @aeroops/api)
 *   - sessionFromMobileClaims (session construction — in @aeroops/api)
 *   - getMyAlerts             (read surface — in @aeroops/api, UNCHANGED;
 *                              requireCapability('app:access') fires inside —
 *                              held by ALL 8 roles; self-scoped to
 *                              session.userId ONLY, never a caller-supplied id)
 *   - toMobileAlertDTO        (mapper — in @aeroops/core, PURE)
 *
 * SECURITY INVARIANTS (ADR-0010, mirrors /api/mobile/v1/schedule):
 *   - org_id is NEVER read from request body, query params, or headers in a
 *     trusted position. It comes ONLY from the verified signed bearer token.
 *   - The subject is ALWAYS session.userId (derived from the token) — there
 *     is no row-identifying input on this route at all, so a caller can
 *     never fetch another member's alerts.
 *   - Expired / tampered / foreign-secret tokens → 401.
 *   - org_id ABSENT from the response body (MobileAlertsResponse).
 *   - No internal error detail returned to the client on 500.
 *   - READ-ONLY, NOT audited, NO money ([VERIFY-4M-SEC-1]).
 *
 * RESPONSE (200 on success):
 *   MobileAlertsResponse { alerts: MobileAlertDTO[], count: number }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import {
  verifyMobileToken,
  sessionFromMobileClaims,
  getMyAlerts,
  UnauthenticatedError,
  ForbiddenError,
} from '@aeroops/api';
import { toMobileAlertDTO } from '@aeroops/core';
import type { MobileAlertsResponse } from '@aeroops/core';

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

    // 4. Fetch the caller's own alerts through the EXISTING gated read.
    //    requireCapability('app:access') + self-scoping fire inside getMyAlerts.
    const result = await getMyAlerts(session);

    // 5. Map to DTOs (org_id absent).
    const response: MobileAlertsResponse = {
      alerts: result.alerts.map(toMobileAlertDTO),
      count: result.count,
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
