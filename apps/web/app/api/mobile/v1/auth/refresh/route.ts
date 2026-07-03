/**
 * apps/web/app/api/mobile/v1/auth/refresh/route.ts
 *
 * Mobile token-refresh endpoint — POST only, Node runtime.
 * Slice 4M-REVOKE ([VERIFY-4M-SEC-1] predecessor).
 *
 * TRANSPORT ADAPTER: NO SQL, NO @aeroops/db import, NO business logic.
 * Delegates entirely to refreshMobileSession (@aeroops/api), which:
 *   - looks up the presented refresh token by its hash,
 *   - rotates it (issues a new access+refresh pair, revokes the old one),
 *   - or, if the presented token was ALREADY rotated (reuse/theft signal),
 *     revokes the entire session chain and refuses.
 *
 * SECURITY INVARIANTS:
 *   - Anti-enumeration: EVERY failure (unknown / expired / revoked / reused
 *     token) → the SAME generic 401 { error: 'invalid_refresh_token' }.
 *   - org_id/userId are NEVER trusted from the request body — they come
 *     ONLY from the mobile_session row the presented token's hash resolves
 *     to (see resolve-mobile-session.ts).
 *   - The new refresh token is returned to the client EXACTLY ONCE, here.
 *   - Unexpected errors → 500 with no internal detail leaked to the client.
 *
 * REQUEST:  { refreshToken: string }
 * RESPONSE (200 on success):
 *   { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb, refreshMobileSession } from '@aeroops/api';

const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

export async function POST(request: Request): Promise<NextResponse> {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'invalid_refresh_token' }, { status: 401 });
    }

    const parsed = refreshRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_refresh_token' }, { status: 401 });
    }

    const db = await getDb();
    const issued = await refreshMobileSession(db, parsed.data.refreshToken);

    if (!issued) {
      // Unknown / expired / revoked / reused — all indistinguishable.
      return NextResponse.json({ error: 'invalid_refresh_token' }, { status: 401 });
    }

    return NextResponse.json(
      {
        accessToken: issued.accessToken,
        accessExpiresAt: issued.accessExpiresAt,
        refreshToken: issued.refreshToken,
        refreshExpiresAt: issued.refreshExpiresAt,
      },
      { status: 200 },
    );
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
