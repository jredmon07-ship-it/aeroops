/**
 * auth/resolve-mobile-session.ts — platform-scoped refresh-token-hash → org/
 * user/chain lookup (the mobile refresh + logout paths only, Slice
 * 4M-REVOKE, migration 0033).
 *
 * SANCTIONED PLATFORM-ADMIN READ (mirrors auth/resolve-org.ts's
 * resolveOrgBySlug / calendar/resolve-feed.ts's resolveFeedByToken EXACTLY —
 * same justification, a different unauthenticated entry point):
 *   resolveMobileSessionByHash is the ONLY function in the mobile
 *   refresh/logout path that is permitted to use withPlatformAdminContext.
 *   It is:
 *     - Read-only (SELECT only — no mutation).
 *     - Single-row result with a FIXED projection (id, orgId, userId,
 *       expiresAt, revokedAt, rotatedToId).
 *     - Keyed by exact match on refresh_token_hash (globally UNIQUE —
 *       mobile_session_refresh_token_hash_unique, migration 0033).
 *     - Called exclusively from refreshMobileSession / revokeMobileSession
 *       (mobile-session.ts), BEFORE any org context can be established (a
 *       refresh/logout request carries only an opaque refresh token — no
 *       AeroOps session/org GUC exists yet).
 *
 *   Every subsequent WRITE (rotate at refresh, revoke at logout, chain
 *   revoke on reuse detection) happens ONLY inside withOrgContext(db,
 *   resolvedOrgId, ...) — the normal per-tenant choke-point — using the
 *   org_id THIS function resolved from OUR OWN table, never from anywhere
 *   client-suppliable. Mirrors build-ics-for-feed.ts's write-after-resolve
 *   pattern exactly.
 *
 * ANTI-ENUMERATION: an unknown hash returns null; the caller must treat
 * "unknown", "revoked", and "expired" identically (a generic 401) — see
 * mobile-session.ts's refreshMobileSession for the full fail-closed matrix.
 *
 * This function is framework-agnostic; it does not import next/*.
 */
import { eq } from 'drizzle-orm';
import { withPlatformAdminContext, mobileSession } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';

export interface ResolvedMobileSession {
  id: string;
  orgId: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  rotatedToId: string | null;
}

/**
 * resolveMobileSessionByHash — looks up a mobile_session row by the sha256
 * hash of a presented raw refresh token.
 *
 * Returns null if no row has this refresh_token_hash (unknown token). Does
 * NOT filter on revoked/expired here — the caller (refreshMobileSession /
 * revokeMobileSession) makes those fail-closed decisions, because a
 * revoked-but-already-rotated row still needs to be visible to trigger the
 * reuse-detection chain-revoke.
 *
 * @param db   - The Drizzle database client (prod or test).
 * @param hash - The sha256 hex digest of the raw refresh token (never the
 *               raw token itself — hashing happens in mobile-session.ts).
 */
export async function resolveMobileSessionByHash(
  db: AnyDb,
  hash: string,
): Promise<ResolvedMobileSession | null> {
  const rows = await withPlatformAdminContext(db, (tx) =>
    tx
      .select({
        id: mobileSession.id,
        orgId: mobileSession.orgId,
        userId: mobileSession.userId,
        expiresAt: mobileSession.expiresAt,
        revokedAt: mobileSession.revokedAt,
        rotatedToId: mobileSession.rotatedToId,
      })
      .from(mobileSession)
      .where(eq(mobileSession.refreshTokenHash, hash))
      .limit(1),
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    rotatedToId: row.rotatedToId,
  };
}
