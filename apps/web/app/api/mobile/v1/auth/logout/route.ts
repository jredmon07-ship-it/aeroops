/**
 * apps/web/app/api/mobile/v1/auth/logout/route.ts
 *
 * Mobile logout endpoint — POST only, Node runtime.
 * Slice 4M-REVOKE ([VERIFY-4M-SEC-1] predecessor).
 *
 * TRANSPORT ADAPTER: NO SQL, NO @aeroops/db import, NO business logic.
 * Delegates entirely to revokeMobileSession (@aeroops/api).
 *
 * IDEMPOTENT / ANTI-ENUMERATION: ALWAYS returns 200, regardless of whether
 * the presented refresh token was known, already revoked, expired, or never
 * existed — a client cannot probe token validity via this route, and a
 * double-tap "Sign Out" (or a retried request) is always safe.
 *
 * REQUEST:  { refreshToken: string }
 * RESPONSE: 200 { ok: true } — always, on any well-formed request.
 *           A malformed body ALSO returns 200 { ok: true } (there is nothing
 *           useful to revoke; failing loudly here would only help an
 *           attacker distinguish request shapes — logout has no secret to
 *           protect on the failure path).
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb, revokeMobileSession } from '@aeroops/api';

const logoutRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

export async function POST(request: Request): Promise<NextResponse> {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const parsed = logoutRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const db = await getDb();
    await revokeMobileSession(db, parsed.data.refreshToken);

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    // Best-effort: even an infrastructure error should not block sign-out on
    // the client (the app clears its local tokens regardless). Return 200
    // rather than leaking internals via a 500 on a route with no secret.
    return NextResponse.json({ ok: true }, { status: 200 });
  }
}
