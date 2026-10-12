/**
 * auth/login-link-token.ts — signed, single-use "login link" tokens.
 *
 * A login link lets an owner/manager hand a member a URL that sets (first
 * login) or resets their password. It is STATELESS — no table, no migration:
 *
 *   - FORMAT: the same @auth/core JWE (A256CBC-HS512) + AUTH_SECRET the web
 *     session and mobile token use, but under its OWN salt
 *     (LOGIN_LINK_TOKEN_SALT). The salt feeds the key derivation, so a web
 *     session / mobile access token cannot even be decrypted here, and a
 *     login-link token cannot be decrypted as either of those. A `purpose`
 *     claim ('login-link') is checked on top as a second, explicit fence.
 *   - CLAIMS: { purpose, userId, orgId, fp } + iat/exp/jti (set by encode).
 *     exp = 7 days.
 *   - SINGLE USE via the credential FINGERPRINT (`fp`): a sha256 of the
 *     member's CURRENT auth_credential.password_hash (or a fixed marker when
 *     they have no credential yet). Accepting a link changes the hash, so the
 *     fingerprint of every earlier link stops matching and they all die —
 *     including the one just used. The hash never leaves the server: the
 *     token is encrypted, and only a digest of the hash is inside it.
 *
 * verifyLoginLinkToken returns null for EVERY failure (bad signature, foreign
 * secret, wrong salt, wrong purpose, expired, malformed) — callers map that to
 * one generic "link no longer valid" message. It does NOT check the
 * fingerprint or membership; that needs the database and lives in
 * acceptLoginLink / checkLoginLink (login-link.ts).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { encode, decode } from 'next-auth/jwt';
import { getSecret } from './mobile-token.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Distinct salt → distinct derived key from the session/mobile tokens. */
const LOGIN_LINK_TOKEN_SALT = 'aeroops.login-link';

/** The `purpose` claim every login-link token carries. */
export const LOGIN_LINK_PURPOSE = 'login-link';

/** 7 days in seconds — how long a login link stays usable. */
export const LOGIN_LINK_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Fingerprint input when the member has no auth_credential yet. */
const NO_CREDENTIAL_MARKER = 'aeroops:no-credential';

// ─── Claims ───────────────────────────────────────────────────────────────────

export interface LoginLinkClaims {
  userId: string;
  orgId: string;
  /** credentialFingerprint() of the member's credential when the link was made. */
  fp: string;
}

// ─── Fingerprint ──────────────────────────────────────────────────────────────

/**
 * credentialFingerprint — sha256 hex of the stored argon2 hash, or of a fixed
 * marker when there is no credential. Deterministic, so a link made before a
 * password change can be told apart from one made after it.
 */
export function credentialFingerprint(passwordHash: string | null | undefined): string {
  return createHash('sha256')
    .update(passwordHash ?? NO_CREDENTIAL_MARKER, 'utf8')
    .digest('hex');
}

/** Constant-time compare of two fingerprints (hex strings). */
export function fingerprintsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ─── Sign / verify ────────────────────────────────────────────────────────────

/**
 * signLoginLinkToken — mints a login-link token valid for 7 days.
 * Refuses (throws) when AUTH_SECRET is unset or the build placeholder.
 */
export async function signLoginLinkToken(claims: LoginLinkClaims): Promise<string> {
  const secret = getSecret('signLoginLinkToken');
  return encode({
    token: {
      purpose: LOGIN_LINK_PURPOSE,
      userId: claims.userId,
      orgId: claims.orgId,
      fp: claims.fp,
    },
    secret,
    salt: LOGIN_LINK_TOKEN_SALT,
    maxAge: LOGIN_LINK_MAX_AGE_SECONDS,
  });
}

/**
 * verifyLoginLinkToken — decrypts + validates a login-link token.
 * Returns the claims, or null on ANY auth failure (never throws for those).
 */
export async function verifyLoginLinkToken(token: string): Promise<LoginLinkClaims | null> {
  const secret = getSecret('verifyLoginLinkToken');
  if (!token) return null;

  try {
    const payload = await decode({ token, secret, salt: LOGIN_LINK_TOKEN_SALT });
    if (!payload) return null;

    const { purpose, userId, orgId, fp } = payload as Record<string, unknown>;
    if (purpose !== LOGIN_LINK_PURPOSE) return null;
    if (
      typeof userId !== 'string' || !userId ||
      typeof orgId !== 'string' || !orgId ||
      typeof fp !== 'string' || !fp
    ) {
      return null;
    }
    return { userId, orgId, fp };
  } catch {
    // Bad signature, foreign secret/salt, expired, malformed.
    return null;
  }
}
