/**
 * middleware.ts — Auth.js session gating for /o/[slug]/* routes.
 *
 * SECURITY MODEL:
 *   1. Any request to /o/[slug]/* without a valid session is redirected to
 *      /o/[slug]/login.
 *   2. If a session exists but session.slug !== URL slug, the user is
 *      redirected to /o/{session.slug}/login. This prevents one tenant's
 *      session from being used to access another tenant's routes.
 *   3. /o/[slug]/login, /o/[slug]/login-link/<token> and /o/[slug]/no-access
 *      are public (no session required).
 *   4. The DB is NEVER queried here — all checks rely on the signed JWT only.
 *      So a session the server has since ended (password reset, membership
 *      removed, org suspended — see packages/api/src/auth/session-revalidation.ts)
 *      still passes here; the page's own auth() returns null and redirects to
 *      /o/[slug]/login, and a server action does the same (lib/action-auth.ts).
 *      Keep the login route public and never send a "signed-in" visitor away
 *      from it, or such a session would loop.
 *
 * EDGE RUNTIME NOTE:
 *   This middleware uses auth-edge.ts (NOT auth.ts) to stay within Edge
 *   Runtime constraints. auth-edge.ts only decodes the JWT; it has no
 *   DB dependencies, no native binaries, and no WebAssembly.
 *
 * SLUG SOURCE OF TRUTH:
 *   org_id for data reads always comes from session.orgId (set by the
 *   authorize callback, embedded in the JWT). The URL slug is only used for
 *   navigation context and the tenant mismatch guard.
 */
import { auth } from '@/auth-edge';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export default auth(function middleware(
  req: NextRequest & { auth: { userId?: string; slug?: string } | null },
) {
  const session = req.auth;
  const { pathname } = req.nextUrl;

  // ── ADR-0013 public booking surface ────────────────────────────────────────
  // /book/* — public booking page (PB1.3, unauthenticated, no session required).
  // /api/public/booking/* — public submit endpoint (PB1.1, the only anon WRITE).
  // Neither is under /o/[slug]/* so they already pass through the org-route
  // matcher below, but we make the allowance EXPLICIT + documented here so a
  // future refactor cannot accidentally close off these paths.
  if (pathname === '/book' || pathname.startsWith('/book/')) {
    return NextResponse.next();
  }
  if (pathname.startsWith('/api/public/')) {
    return NextResponse.next();
  }

  // ── Self-serve signup (Slice SIGNUP) ────────────────────────────────────────
  // /signup — public org-creation page (unauthenticated: the visitor has no org
  // yet). Not under /o/[slug]/* so it already falls through the matcher; made
  // explicit here alongside /book so a future refactor cannot close it off.
  if (pathname === '/signup' || pathname.startsWith('/signup/')) {
    return NextResponse.next();
  }

  // ── Slice P1.4 public calendar feed ────────────────────────────────────────
  // /api/calendar/[token] — public, unauthenticated .ics GET (a calendar app
  // cannot do session auth). Not under /o/[slug]/* so it already passes
  // through the matcher below; documented explicitly, same as /api/public/*
  // and /api/mobile/*, so a future refactor cannot accidentally close it off.
  // The opaque per-feed token (resolveFeedByToken, @aeroops/api) IS the auth.
  if (pathname.startsWith('/api/calendar/')) {
    return NextResponse.next();
  }

  // Match /o/[slug]/... routes
  const orgRouteMatch = pathname.match(/^\/o\/([^/]+)(\/.*)?$/);
  if (!orgRouteMatch) {
    // Not a tenant route — allow through (root /, static assets, API routes)
    return NextResponse.next();
  }

  const urlSlug = orgRouteMatch[1]!;
  const subPath = orgRouteMatch[2] ?? '';

  // Public tenant sub-routes: login, login-link (set a password from a signed
  // link — the token IS the auth, verified server-side), no-access
  const isPublicSubRoute =
    subPath === '/login' ||
    subPath.startsWith('/login/') ||
    subPath.startsWith('/login-link/') ||
    subPath === '/no-access' ||
    subPath.startsWith('/no-access/');

  if (isPublicSubRoute) {
    return NextResponse.next();
  }

  // Protected route: require a valid session
  if (!session || !session.userId) {
    const loginUrl = new URL(`/o/${urlSlug}/login`, req.url);
    return NextResponse.redirect(loginUrl);
  }

  // Slug mismatch guard: fail-closed — if slug is missing OR wrong, redirect.
  // A valid session on a protected /o/[slug]/* route MUST carry a slug that
  // matches the URL. A missing slug (falsy) is treated as a mismatch so that
  // a truncated or tampered JWT can never silently pass through.
  if (!session.slug || session.slug !== urlSlug) {
    // If we have a known slug in the session, send the user to their real org's
    // login; otherwise fall back to the URL slug's login page.
    const targetSlug = session.slug || urlSlug;
    const loginUrl = new URL(`/o/${targetSlug}/login`, req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  // Match all routes except Next.js internals and static files
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
