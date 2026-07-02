/**
 * apps/web/app/api/integrations/qbo/callback/route.ts
 *
 * The QuickBooks Online OAuth2 callback — GET only, Node runtime.
 * Intuit redirects the browser here with ?code=...&realmId=...&state=...
 * after the operator approves the connection on Intuit's own site.
 *
 * ── TRANSPORT ADAPTER ONLY ────────────────────────────────────────────────────
 * NO SQL, NO @aeroops/db import, NO business logic. Delegates entirely to
 * completeQboOAuth (@aeroops/api), which:
 *   - requireCapability(session, 'org:manage_settings') FIRST — the browser
 *     still carries the session cookie from the SAME browser that started
 *     the flow.
 *   - verifies the signed `state` param AND cross-checks it against the
 *     CURRENT session's (orgId, userId) — org_id is NEVER taken from this
 *     callback's query string. A mismatched/expired/forged state is refused
 *     before any DB write (integrations/qbo/connect.ts + state.ts).
 *
 * On success/failure this redirects back to the org settings page with a
 * `?qbo=` status flag for the card to (optionally) surface; the card's own
 * status fetch on mount is the source of truth either way.
 *
 * NO card/bank data. NO Stripe. NO money moves in this route.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { completeQboOAuth, ForbiddenError, UnauthenticatedError } from '@aeroops/api';

export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth();
  const slug = session?.slug;
  const url = new URL(request.url);

  if (!slug) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  const code = url.searchParams.get('code');
  const realmId = url.searchParams.get('realmId');
  const state = url.searchParams.get('state');

  if (!code || !realmId || !state) {
    return NextResponse.redirect(new URL(`/o/${slug}/settings?qbo=invalid_callback`, request.url));
  }

  try {
    const result = await completeQboOAuth(session, { code, realmId, state });
    if (!result.ok) {
      return NextResponse.redirect(new URL(`/o/${slug}/settings?qbo=${result.reason}`, request.url));
    }
    return NextResponse.redirect(new URL(`/o/${slug}/settings?qbo=connected`, request.url));
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
