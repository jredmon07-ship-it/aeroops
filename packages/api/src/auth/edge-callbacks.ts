/**
 * edge-callbacks.ts — Edge-safe Auth.js callbacks and edge config factory.
 *
 * EDGE-SAFETY GUARANTEE:
 *   This file MUST NOT import anything that requires Node.js native binaries,
 *   WebAssembly, or database connections. Specifically, it must never import:
 *     - @aeroops/db (pglite + drizzle)
 *     - @node-rs/argon2
 *     - @electric-sql/pglite
 *     - ./resolve-org.js
 *     - ./verify-credential.js
 *     - ../db.js
 *
 *   These functions are pure field-copy operations that move data between the
 *   Auth.js JWT token and the session object. They are safe for Edge Runtime.
 *
 * WHY A SEPARATE FILE:
 *   auth-config.ts imports Credentials, zod, resolve-org, and verify-credential
 *   at the module level (even though those are only needed by the full auth config's
 *   authorize callback). Importing auth-config.ts from the edge bundle would pull
 *   those in — and db/argon2 would transitively enter the edge bundle.
 *
 *   This file contains ONLY the two callbacks and buildEdgeAuthConfig, making it
 *   safe to import from apps/web/auth-edge.ts without any native dep risk.
 *
 * SINGLE SOURCE OF TRUTH:
 *   auth-config.ts (the full config) re-exports jwtCallback and sessionCallback
 *   from HERE. buildAuthConfig() uses sessionCallback as is, and its jwt
 *   callback (session-revalidation.ts) runs jwtCallback first, then checks the
 *   token against the database. So both configs project identical fields; only
 *   the Node one revalidates. The edge config stays signature-only and is never
 *   the authorization source: every page and server action calls the Node
 *   auth().
 */

import { isMembershipRole } from '@aeroops/core';

// ─── Shared JWT callback ──────────────────────────────────────────────────────

/**
 * jwtCallback — copies AeroOps custom fields from the authorize() result into
 * the JWT token on sign-in. On subsequent requests (user absent) it is a no-op,
 * so the edge config passes every claim through untouched, `cfp` included.
 *
 * Fields projected into token: userId, orgId, slug, role, email, cfp.
 * `user.id` (Auth.js canonical) is renamed to `token.userId`.
 * `cfp` is the session credential fingerprint the Node config checks on every
 * read (session-revalidation.ts). It is opaque here, and sessionCallback never
 * projects it onto the session.
 *
 * ROLE VALIDATION: role is validated with isMembershipRole() before being
 * written to the token. An invalid role (injected, SSO-supplied, or malformed)
 * is silently dropped — the token will carry no role field, which causes
 * sessionCallback to produce a session without a role, which in turn makes
 * requireCapability/withSessionOrgContext throw UnauthenticatedError (clean
 * deny, never a TypeError).
 *
 * EDGE-SAFE: pure field copy, no I/O.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function jwtCallback({ token, user }: { token: any; user: any }): Promise<any> {
  if (user) {
    // Initial sign-in: copy authorize() result into the JWT.
    // `user.id` is Auth.js's canonical field; we rename to userId in the token.
    token['userId'] = user.id as string;
    token['orgId'] = user.orgId as string;
    token['slug'] = user.slug as string;
    // Validate the role at the session boundary. If the value from authorize()
    // is not a known MembershipRole, do NOT write it to the token so that
    // downstream checks degrade to UnauthenticatedError rather than TypeError.
    if (isMembershipRole(user.role)) {
      token['role'] = user.role;
    }
    // (If role is invalid, token['role'] is left absent — no field written.)
    token['email'] = user.email as string;
    // Without a cfp the Node config refuses the token on its next read.
    if (typeof user.cfp === 'string' && user.cfp) {
      token['cfp'] = user.cfp;
    }
  }
  return token;
}

// ─── Shared session callback ──────────────────────────────────────────────────

/**
 * sessionCallback — projects JWT token fields onto the session object so that
 * apps/web's `auth()` helper returns the AppSession shape (userId, orgId, slug,
 * role, user.email).
 *
 * password_hash is NEVER on the token and therefore never on the session.
 * `cfp` IS on the token and is deliberately never projected. session.user is
 * always set below — next-auth's server-side auth() returns
 * `{ user: token, ...session }`, so without our own `user` the whole token
 * (cfp included) would become session.user.
 *
 * ROLE VALIDATION: token['role'] is validated with isMembershipRole() before
 * being written to session.role. A token carrying an invalid role value (e.g.
 * one injected via SSO or token tampering) will produce a session with no role
 * field, causing requireCapability/withSessionOrgContext to throw
 * UnauthenticatedError (clean deny, never a TypeError or 500).
 *
 * EDGE-SAFE: pure field copy, no I/O.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sessionCallback({ session, token }: { session: any; token: any }): Promise<any> {
  session.userId = token['userId'] as string;
  session.orgId = token['orgId'] as string;
  session.slug = token['slug'] as string;
  // Validate the role at the session boundary. If token['role'] is not a
  // valid MembershipRole (prototype-key, injected string, missing, etc.),
  // omit session.role entirely so downstream guards throw UnauthenticatedError.
  const tokenRole = token['role'];
  if (isMembershipRole(tokenRole)) {
    session.role = tokenRole;
  }
  // (If role is invalid, session.role is left absent — not written at all.)
  // user.email: Auth.js already copies token.email to session.user.email
  // in v5 beta, but we set it explicitly for clarity and safety.
  if (session.user) {
    session.user.email = token['email'] as string;
  } else {
    session.user = { email: token['email'] as string };
  }
  return session;
}

// ─── Edge auth config factory ─────────────────────────────────────────────────

/**
 * buildEdgeAuthConfig — returns a minimal NextAuth config for the Edge Runtime.
 *
 * Used exclusively by apps/web/auth-edge.ts. No providers, no db, no argon2.
 * The only job: decode + verify the JWT and populate req.auth with the custom
 * session fields (userId, orgId, slug, role) for use in middleware.ts.
 *
 * SIGNATURE-ONLY: it cannot see a password reset, a removed membership or a
 * role change, so a revoked session still passes the middleware. That is
 * safe because the page's own auth() (the Node config) returns null and the
 * page redirects to /o/<slug>/login, which the middleware never bounces.
 *
 * AUTH_SECRET must be identical to the one used by the full auth config so the
 * JWT signed by auth.ts can be verified by this edge config.
 *
 * Throws at call time if AUTH_SECRET is unset.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildEdgeAuthConfig(): any {
  const secret = process.env['AUTH_SECRET'];
  if (!secret) {
    throw new Error(
      '[buildEdgeAuthConfig] AUTH_SECRET environment variable is not set.',
    );
  }

  return {
    secret,
    trustHost: true,
    session: {
      strategy: 'jwt' as const,
      maxAge: 60 * 60 * 8,
    },
    providers: [],
    callbacks: {
      jwt: jwtCallback,
      session: sessionCallback,
    },
  };
}
