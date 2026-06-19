/**
 * apps/web/app/api/mobile/v1/auth/login/route.ts
 *
 * Mobile login endpoint — POST only, Node runtime.
 *
 * TRANSPORT ADAPTER: this route contains NO SQL, NO @aeroops/db import,
 * and NO business logic. It delegates entirely to:
 *   - verifyLoginAndIssueClaims  (login orchestration — in @aeroops/api)
 *   - signMobileToken            (token minting — in @aeroops/api)
 *
 * SECURITY INVARIANTS (ADR-0010):
 *   - Anti-enumeration: ALL auth failures → 401 { error: 'invalid_credentials' }
 *     (byte-identical body + status; no which-step distinction).
 *   - org_id is NEVER trusted from the request body or headers; it comes from
 *     the signed token claim (derived server-side from the slug lookup).
 *   - Never returns password_hash, userId beyond need, or cross-org data.
 *   - Unexpected errors → 500 with no internal detail leaked to the client.
 *
 * RESPONSE (200 on success):
 *   { token, expiresAt, org: { slug, name }, user: { email, role } }
 *
 * [VERIFY-4M-SEC-2] Rate-limit + WAF on this route before distribution.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getDb, loginSchema, verifyLoginAndIssueClaims, signMobileToken } from '@aeroops/api';
import { resolveOrgBySlug } from '@aeroops/api';

const MOBILE_TOKEN_MAX_AGE_SECONDS = 60 * 60 * 8; // 8 hours

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // 1. Parse JSON body.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      // Malformed JSON → generic 401 (not 400) to avoid enumeration signal.
      return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    // 2. Validate shape with the shared loginSchema.
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      // Invalid shape → generic 401.
      return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    // 3. Get the production DB client.
    const db = await getDb();

    // 4. Run the shared login pipeline.
    //    Returns claims on success, null on ANY auth failure.
    const claims = await verifyLoginAndIssueClaims(db, parsed.data);
    if (!claims) {
      return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    // 5. Mint the mobile bearer token.
    const token = await signMobileToken(claims);

    // 6. Fetch the org name for the response body (minimal read — only name).
    //    resolveOrgBySlug is safe here: it only returns {id,name,slug,status}.
    //    We already verified the slug is active in the pipeline above, but we
    //    need the name for the response. We re-resolve by slug (cached by the
    //    memoized DB client; no second network round-trip in practice).
    //    SECURITY: we use the claims.slug (from the signed pipeline), not the
    //    client-supplied slug — even though they're the same after parse+verify,
    //    this makes the source explicit.
    const resolvedOrg = await resolveOrgBySlug(db, claims.slug);
    const orgName = resolvedOrg?.name ?? claims.slug;

    // 7. Build the expiresAt timestamp.
    const expiresAt = new Date(Date.now() + MOBILE_TOKEN_MAX_AGE_SECONDS * 1000).toISOString();

    // 8. Return the response.
    //    userId is NEVER returned — it is exclusively a signed-token claim.
    //    orgId is NEVER returned on the wire body.
    return NextResponse.json(
      {
        token,
        expiresAt,
        org: {
          slug: claims.slug,
          name: orgName,
        },
        user: {
          email: claims.email,
          role: claims.role,
        },
      },
      { status: 200 },
    );
  } catch {
    // Unexpected infrastructure error — 500 with no internal detail.
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
