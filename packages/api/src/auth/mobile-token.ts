/**
 * mobile-token.ts — Mobile bearer token helpers.
 *
 * Wraps @auth/core's encode/decode (re-exported by next-auth/jwt) to mint
 * and verify mobile bearer tokens that carry the SAME claim shape as the web
 * JWT session: { userId, orgId, slug, role, email }.
 *
 * SECURITY INVARIANTS:
 *   - ONE secret: AUTH_SECRET (same env var as the web session).
 *   - ONE encryption format: @auth/core JWE (A256CBC-HS512), not forked —
 *     but under the token's OWN salt plus a `purpose` claim, so it is never
 *     interchangeable with a web session cookie (see SALT NOTE).
 *   - [VERIFY-4M-SEC-1] SHORT-LIVED expiry (maxAge = 60 * 15 = 15 minutes) —
 *     changed from the original 8h (Slice 4M.1) as part of the mobile
 *     token-revocation predecessor (Slice 4M-REVOKE, migration 0033). A
 *     stateless JWT can never be revoked mid-flight; keeping it short-lived
 *     means the ONLY way to get a new one is a refresh that IS checked
 *     against the revocable `mobile_session` table (see
 *     packages/api/src/auth/mobile-session.ts) — that is where instant
 *     revocation actually lives, not in this file.
 *   - REFUSE to mint if AUTH_SECRET is unset or is the build-time placeholder
 *     (mirrors apps/web/auth.ts fail-fast guard).
 *   - verifyMobileToken returns null on bad signature / expired / malformed /
 *     foreign-secret / foreign salt / missing purpose — never throws for auth
 *     failures.
 *   - sessionFromMobileClaims fail-closed on garbage role: an invalid/missing
 *     role produces a session WITHOUT a role field, so downstream
 *     requireCapability/withSessionOrgContext throw UnauthenticatedError.
 *
 * SALT NOTE:
 *   @auth/core derives the encryption key from AUTH_SECRET plus a `salt`, and
 *   Auth.js uses the session COOKIE NAME as that salt: "authjs.session-token"
 *   on an http:// origin (`pnpm start`, a self-hosted http://server:3000, a
 *   TLS proxy that does not send X-Forwarded-Proto: https). A mobile token
 *   under that salt would be interchangeable with the web session cookie: the
 *   cookie would verify here as a bearer token (skipping the web session
 *   check in session-revalidation.ts, so a reset or demotion would never reach
 *   the mobile routes), and a 15-minute mobile token sent as the cookie would
 *   come back from the middleware re-issued for 8 hours. So, like
 *   login-link-token.ts, this token has its OWN salt — neither decrypts as the
 *   other — and MOBILE_TOKEN_PURPOSE is checked on top as a second, explicit
 *   fence. (Access tokens minted under the old shared salt stopped verifying
 *   when it changed; the app's 401 → refresh path re-mints them. Refresh
 *   tokens are opaque database rows and were unaffected.)
 */

import { encode, decode } from 'next-auth/jwt';
import { isMembershipRole } from '@aeroops/core';
import type { MembershipRole } from '@aeroops/core';
import type { AppSession } from './types.js';
import type { MobileClaims } from './verify-login.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * MOBILE_TOKEN_SALT — the salt passed to @auth/core encode/decode.
 *
 * Must be consistent across sign and verify calls, and must never equal an
 * Auth.js session cookie name ("authjs.session-token" on http,
 * "__Secure-authjs.session-token" on https) — see SALT NOTE.
 */
const MOBILE_TOKEN_SALT = 'aeroops.mobile-access-token';

/** The `purpose` claim every mobile access token carries (and must carry). */
export const MOBILE_TOKEN_PURPOSE = 'mobile-access';

/**
 * MOBILE_ACCESS_TOKEN_MAX_AGE_SECONDS — 15 minutes in seconds.
 *
 * [VERIFY-4M-SEC-1] Short-lived by design (Slice 4M-REVOKE): the access
 * token itself is never revoked/checked against the DB — it just expires
 * fast. Instant revocation is achieved by requiring a refresh (checked
 * against the revocable `mobile_session` table) to mint a new one. Exported
 * so issueMobileSession/refreshMobileSession (mobile-session.ts) can compute
 * the matching `accessExpiresAt` without duplicating the literal.
 */
export const MOBILE_ACCESS_TOKEN_MAX_AGE_SECONDS = 60 * 15;

/**
 * BUILD_PHASE_PLACEHOLDER — the known-bad placeholder that must never be used
 * at runtime. Mirrors the check in apps/web/auth.ts.
 */
const BUILD_PHASE_PLACEHOLDER = 'build-time-placeholder-not-a-real-secret-replace-me';

// ─── Secret guard ─────────────────────────────────────────────────────────────

/**
 * getSecret — reads AUTH_SECRET and refuses the build-time placeholder.
 *
 * Throws synchronously (fast, clear error) rather than minting a bad token.
 * Called at the top of signMobileToken and verifyMobileToken so failures are
 * always explicit. Also used by login-link-token.ts (same secret, its own
 * salt) — `label` only names the caller in the error message.
 *
 * @throws Error if AUTH_SECRET is unset or is the placeholder.
 */
export function getSecret(label = 'signMobileToken'): string {
  const secret = process.env['AUTH_SECRET'];
  if (!secret) {
    throw new Error(
      `[${label}] AUTH_SECRET is not set. ` +
        'Set it in .env (see .env.example) — never hardcode the secret.',
    );
  }
  if (secret === BUILD_PHASE_PLACEHOLDER) {
    throw new Error(
      `[${label}] AUTH_SECRET is the build-time placeholder. ` +
        'This value must not be used at runtime — it is a known string and ' +
        'allows JWT forgery. Set a real secret in .env.',
    );
  }
  return secret;
}

// ─── Token helpers ────────────────────────────────────────────────────────────

/**
 * signMobileToken — mints a signed+encrypted mobile bearer token.
 *
 * Uses @auth/core's encode() (JWE, A256CBC-HS512) with AUTH_SECRET, this
 * token's own salt and a 15-minute maxAge. The payload carries the identity
 * claims the web session does — { userId, orgId, slug, role, email } — plus
 * `purpose: MOBILE_TOKEN_PURPOSE`, and nothing else (never `cfp`).
 *
 * REFUSES to mint if AUTH_SECRET is unset or is the build-phase placeholder.
 *
 * @param claims - The MobileClaims from verifyLoginAndIssueClaims.
 * @returns      - The encoded JWE token string (opaque to the device).
 * @throws       - If AUTH_SECRET is missing or is the placeholder.
 */
export async function signMobileToken(claims: MobileClaims): Promise<string> {
  const secret = getSecret();

  return encode({
    token: {
      purpose: MOBILE_TOKEN_PURPOSE,
      userId: claims.userId,
      orgId: claims.orgId,
      slug: claims.slug,
      role: claims.role,
      email: claims.email,
    },
    secret,
    salt: MOBILE_TOKEN_SALT,
    maxAge: MOBILE_ACCESS_TOKEN_MAX_AGE_SECONDS,
  });
}

/**
 * verifyMobileToken — decodes and verifies a mobile bearer token.
 *
 * Returns the claims on a valid, unexpired, correctly-signed token.
 * Returns null on bad signature / expired / malformed / foreign-secret, and
 * on anything that is not a mobile access token: a web session cookie or a
 * login link (another salt — they do not even decrypt here), or a payload
 * without `purpose: MOBILE_TOKEN_PURPOSE`.
 * Never throws for auth failures — only re-throws infrastructure errors.
 *
 * @param token - The bearer token string from the Authorization header.
 * @returns     - MobileClaims on success; null on any auth failure.
 */
export async function verifyMobileToken(token: string): Promise<MobileClaims | null> {
  const secret = getSecret();

  try {
    const payload = await decode({
      token,
      secret,
      salt: MOBILE_TOKEN_SALT,
    });

    if (!payload) {
      return null;
    }

    // Only a token signMobileToken minted (see SALT NOTE).
    if (payload['purpose'] !== MOBILE_TOKEN_PURPOSE) {
      return null;
    }

    // Validate required fields are present.
    const userId = payload['userId'];
    const orgId = payload['orgId'];
    const slug = payload['slug'];
    const role = payload['role'];
    const email = payload['email'];

    if (
      typeof userId !== 'string' || !userId ||
      typeof orgId !== 'string' || !orgId ||
      typeof slug !== 'string' || !slug ||
      typeof role !== 'string' || !role ||
      typeof email !== 'string' || !email
    ) {
      return null;
    }

    return { userId, orgId, slug, role, email };
  } catch {
    // Bad signature, expired, malformed — return null (not a throw).
    return null;
  }
}

/**
 * sessionFromMobileClaims — builds an AppSession from verified mobile claims.
 *
 * FAIL-CLOSED on role: if the role from the token is not a valid MembershipRole,
 * the session is returned WITHOUT a role field. This means downstream
 * requireCapability/withSessionOrgContext throw UnauthenticatedError (clean
 * deny), never a TypeError or 500. Mirrors the sessionCallback behavior.
 *
 * @param claims - MobileClaims from verifyMobileToken.
 * @returns      - AppSession (role absent if invalid).
 */
export function sessionFromMobileClaims(claims: MobileClaims): AppSession {
  const base = {
    userId: claims.userId,
    orgId: claims.orgId,
    slug: claims.slug,
    user: { email: claims.email },
  };

  if (isMembershipRole(claims.role)) {
    return {
      ...base,
      role: claims.role as MembershipRole,
    };
  }

  // Role is invalid — return session WITHOUT role so downstream guards throw
  // UnauthenticatedError (fail-closed, never a TypeError).
  return base as AppSession;
}
