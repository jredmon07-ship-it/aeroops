/**
 * apps/web/app/api/calendar/[token]/route.ts
 *
 * Public subscribable .ics calendar feed — GET only, Node runtime.
 *
 * ── TRANSPORT ADAPTER ONLY ───────────────────────────────────────────────────
 * This route contains:
 *   - NO SQL
 *   - NO @aeroops/db import
 *   - NO business logic
 *
 * It delegates entirely to:
 *   - resolveFeedByToken (in @aeroops/api) — the ONE sanctioned platform-admin
 *     read that resolves the opaque URL token to {orgId, userId, scope,
 *     resourceId}, BEFORE any org context exists.
 *   - buildIcsForFeed    (in @aeroops/api) — every reservation read + the
 *     best-effort last_accessed_at bump, all inside withOrgContext using the
 *     org_id resolveFeedByToken resolved from OUR OWN calendar_feed row.
 *
 * ── SECURITY INVARIANTS ───────────────────────────────────────────────────────
 *   - The token comes ONLY from the URL path segment (params.token) — there is
 *     no request body, no query string input, no session on this route at all.
 *     THE TOKEN IS THE ONLY AUTH — same capability-URL posture as the mobile
 *     bearer token (ADR-0010): possession = read access to exactly this feed.
 *   - ANTI-ENUMERATION: an unknown token, a revoked (inactive) token and a
 *     feed whose owner can no longer read it (removed, org suspended, or —
 *     for an aircraft feed — no longer fleet:access; resolveFeedByToken
 *     re-checks on every fetch) are BYTE-IDENTICAL 404 responses —
 *     resolveFeedByToken already collapses every case to `null`; this route
 *     never distinguishes them further (no different status code, no
 *     different body, no timing-sensitive extra work on either path).
 *   - NO org id, user id, or any tenant identifier ever appears in the
 *     response — the .ics body carries only event start/end/summary/
 *     description text (see buildIcsForFeed / packages/core's buildIcs).
 *   - Calendar apps (Apple/Google/Outlook) poll this URL periodically over
 *     plain HTTPS with no custom headers — GET-only, no auth header expected.
 *
 * ── ACCESSIBLE VIA MIDDLEWARE ─────────────────────────────────────────────────
 * /api/calendar/* is NOT under /o/[slug]/* so it passes through the existing
 * middleware without hitting the session check, same as /api/public/booking/*
 * and /api/mobile/*.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getDb, resolveFeedByToken, buildIcsForFeed } from '@aeroops/api';

/** A generic 404 — used for BOTH "token never existed" and "token revoked"
 * so a prober cannot distinguish the two (anti-enumeration). */
function notFound(): NextResponse {
  return new NextResponse('Not found', { status: 404 });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;

  if (!token || typeof token !== 'string') {
    return notFound();
  }

  const db = await getDb();

  let feed;
  try {
    feed = await resolveFeedByToken(db, token);
  } catch {
    // Never leak internal error detail on a public, unauthenticated route.
    return notFound();
  }

  if (!feed) {
    // Unknown, revoked, or its owner lost access — indistinguishable
    // (resolveFeedByToken already collapses all of them to null).
    return notFound();
  }

  let ics: string;
  try {
    ics = await buildIcsForFeed(db, feed);
  } catch {
    return new NextResponse('Internal error', { status: 500 });
  }

  return new NextResponse(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="aeroops.ics"',
      // Calendar apps poll on their own schedule; discourage aggressive
      // intermediary caching without forbidding client-side refresh.
      'Cache-Control': 'no-cache, private',
    },
  });
}
