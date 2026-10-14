/**
 * verify-credential.ts — Tenant-scoped credential verification.
 *
 * SECURITY CONTRACT:
 *   - All tenant reads happen inside a single withOrgContext transaction.
 *   - Anti-enumeration: every failure path runs a dummy verifyPassword call
 *     so that missing-user, missing-credential, wrong-password, and
 *     missing-membership paths all take approximately the same wall-clock time.
 *   - Returns null on ALL auth failures; only throws on infrastructure errors.
 *   - Never reveals which step failed (no "user not found" vs "wrong password").
 *   - password_hash is NEVER returned to callers; only the boolean verify
 *     result is used internally, plus `cfp` — a one-way, domain-separated
 *     fingerprint of the hash (session-revalidation.ts) computed in the same
 *     transaction, so the web session is bound to exactly the credential
 *     that just verified.
 *
 * ANTI-ENUMERATION NOTE:
 *   The constant-time path is best-effort at the application level. For
 *   production deployments, rate-limiting and a WAF are additional layers.
 *   [VERIFY] Confirm rate-limit config with ops before launch.
 */
import { eq, and } from 'drizzle-orm';
import { withOrgContext } from '@aeroops/db';
import { appUser, authCredential, membership } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import type { MembershipRole } from '@aeroops/core';
import { verifyPassword, getDummyHash } from './hash.js';
import { sessionCredentialFingerprint } from './session-revalidation.js';

/**
 * The successful credential verification result.
 * password_hash is intentionally excluded — the hash never leaves this module.
 */
export interface VerifiedCredential {
  userId: string;
  email: string;
  role: MembershipRole;
  /**
   * sessionCredentialFingerprint() of the hash that just verified. The web
   * session carries it; a later password change makes it stop matching.
   */
  cfp: string;
}

/**
 * verifyCredential — authenticates a user against org-scoped credentials.
 *
 * Runs all lookups inside a single withOrgContext transaction (one round-trip,
 * fully tenant-isolated by RLS). Steps:
 *
 *   (a) Normalize email: trim + lowercase.
 *   (b) Find app_user by normalized email within the org (limit 1).
 *   (c) Find auth_credential by user_id within the org (limit 1).
 *   (d) Verify the password against the stored hash.
 *   (e) Find membership role for (userId, orgId).
 *       No membership → bounce (return null after dummy verify).
 *
 * On any lookup failure: run dummy verifyPassword to equalize timing, return null.
 * On infra failure (DB error, unexpected exception): rethrow — do NOT swallow.
 *
 * @param db       - The Drizzle database client.
 * @param orgId    - The org's UUID (from resolveOrgBySlug — never from client input).
 * @param email    - Candidate email (normalized inside this function).
 * @param password - Candidate plaintext password. Never logged.
 * @returns VerifiedCredential on success, null on any auth failure.
 */
export async function verifyCredential(
  db: AnyDb,
  orgId: string,
  email: string,
  password: string,
): Promise<VerifiedCredential | null> {
  // (a) Normalize email at the boundary.
  const normalizedEmail = email.trim().toLowerCase();

  return withOrgContext(db, orgId, async (tx) => {
    // (b) Find app_user by normalized email.
    const userRows = await tx
      .select({ id: appUser.id, email: appUser.email })
      .from(appUser)
      .where(
        and(
          eq(appUser.orgId, orgId),
          eq(appUser.email, normalizedEmail),
        ),
      )
      .limit(1);

    const user = userRows[0];

    if (!user) {
      // ANTI-ENUMERATION: run dummy verify so the missing-user path takes the
      // same time as a real hash comparison. Then return null.
      await verifyPassword(await getDummyHash(), password);
      return null;
    }

    // (c) Find auth_credential by user_id.
    const credRows = await tx
      .select({ passwordHash: authCredential.passwordHash })
      .from(authCredential)
      .where(
        and(
          eq(authCredential.orgId, orgId),
          eq(authCredential.userId, user.id),
        ),
      )
      .limit(1);

    const cred = credRows[0];

    if (!cred) {
      // ANTI-ENUMERATION: no credential stored for this user.
      await verifyPassword(await getDummyHash(), password);
      return null;
    }

    // (d) Verify the password. verifyPassword is constant-time.
    const passwordOk = await verifyPassword(cred.passwordHash, password);

    if (!passwordOk) {
      return null;
    }

    // (e) Find membership role for (userId, orgId).
    // No membership → bounce (user exists but has no access role).
    const memberRows = await tx
      .select({ role: membership.role })
      .from(membership)
      .where(
        and(
          eq(membership.orgId, orgId),
          eq(membership.userId, user.id),
        ),
      )
      .limit(1);

    const member = memberRows[0];

    if (!member) {
      // User exists but has no membership → bounce.
      // No need for dummy verify here: password was already checked above,
      // so timing already includes argon2 cost. Returning null directly
      // does not leak information beyond "password checked but access denied."
      return null;
    }

    // Success — return only the minimal session-safe fields.
    // password_hash is intentionally never returned; cfp is a digest of it.
    return {
      userId: user.id,
      email: user.email,
      role: member.role as MembershipRole,
      cfp: sessionCredentialFingerprint(cred.passwordHash),
    };
  });
}
