/**
 * apps/web/app/api/integrations/qbo/connect/route.ts
 *
 * Starts the QuickBooks Online OAuth2 connect flow — GET only, Node runtime.
 *
 * ── TRANSPORT ADAPTER ONLY ────────────────────────────────────────────────────
 * This route contains NO SQL, NO @aeroops/db import, NO business logic. It
 * delegates entirely to buildQboAuthorizeUrl (in @aeroops/api), which:
 *   - requireCapability(session, 'org:manage_settings') FIRST.
 *   - mints a short-lived signed state token bound to (session.orgId,
 *     session.userId) — see integrations/qbo/state.ts.
 *   - builds the Intuit authorize URL.
 *
 * Requires an authenticated session with org:manage_settings — an
 * unauthenticated or under-privileged request is redirected to the org's
 * login / settings page (never a raw 401/403 JSON error, matching the rest
 * of the app's browser-navigation routes).
 *
 * NO card/bank data. NO Stripe. NO money moves in this route.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { buildQboAuthorizeUrl, ForbiddenError, UnauthenticatedError } from '@aeroops/api';

export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth();
  const slug = session?.slug;

  // No slug on the session (unauthenticated) → send to the generic login page.
  if (!slug) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  try {
    const result = await buildQboAuthorizeUrl(session);
    if (!result.ok) {
      // not_configured — bounce back to settings; the card explains the state.
      return NextResponse.redirect(new URL(`/o/${slug}/settings?qbo=not_configured`, request.url));
    }
    return NextResponse.redirect(result.url);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return NextResponse.redirect(new URL(`/o/${slug}/no-access?reason=insufficient_role`, request.url));
    }
    if (err instanceof UnauthenticatedError) {
      return NextResponse.redirect(new URL(`/o/${slug}/login`, request.url));
    }
    return NextResponse.redirect(new URL(`/o/${slug}/settings?qbo=error`, request.url));
  }
}
