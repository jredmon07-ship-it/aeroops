/**
 * auth-config.ts — Auth.js v5 configuration factory for AeroOps.
 *
 * USAGE (apps/web — frontend-engineer's job):
 *
 *   // apps/web/auth.ts
 *   import NextAuth from 'next-auth';
 *   import { buildAuthConfig } from '@aeroops/api';
 *
 *   export const { auth, handlers, signIn, signOut } = NextAuth(buildAuthConfig());
 *
 *   // apps/web/app/api/auth/[...nextauth]/route.ts
 *   export { handlers as GET, handlers as POST };
 *
 *   // apps/web/middleware.ts
 *   export { auth as middleware } from '@/auth';
 *   export const config = { matcher: [...] };
 *
 * WHAT THIS FILE DOES:
 *   - Exports buildAuthConfig() which returns a NextAuth config OBJECT.
 *   - Does NOT call NextAuth() — that is apps/web's responsibility.
 *   - Validates AUTH_SECRET at config-build time (fail-fast if missing).
 *   - Obtains the DB client lazily via getDb() inside the async authorize
 *     callback — never at module load time and never requiring the caller
 *     to pass a db argument.
 *
 * BOUNDARY INVARIANT:
 *   apps/web must NOT import from @aeroops/db. buildAuthConfig() requires no
 *   db argument; the production DB client is obtained internally via getDb()
 *   which lives in @aeroops/api/src/db.ts and is the sole import point for
 *   @aeroops/db in the app layer.
 *
 * TESTABILITY:
 *   buildAuthConfig's authorize callback calls getDb() which cannot be used in
 *   unit tests (no real DATABASE_URL). Tests exercise the logic functions
 *   directly: resolveOrgBySlug(db, …) and verifyCredential(db, …) both accept
 *   an explicit db parameter (pglite test client). See auth.smoke.test.ts.
 *
 * AUTH.JS v5 (5.0.0-beta.31) API NOTES AND DEVIATIONS:
 *   - The Credentials provider `authorize` function signature is
 *     `authorize(credentials: Partial<Record<string,unknown>>): Promise<User | null>`.
 *     We validate the shape with zod before using the values.
 *   - `session.strategy: 'jwt'` is the only strategy supported without a
 *     database adapter; we do not use an adapter (JWTs are stateless).
 *   - `callbacks.jwt` receives `{ token, user, trigger }`. `user` is only
 *     populated on the initial sign-in (trigger === 'signIn' | 'signUp').
 *   - `callbacks.session` receives `{ session, token }` and must return the
 *     extended session (our AppSession shape).
 *   - `trustHost: true` is required when running behind a proxy/load-balancer
 *     or in a non-HTTPS local environment.
 *   - The authorize function must return null (not throw) for auth failures;
 *     throwing causes a 500 rather than an auth failure redirect.
 *
 * DEVIATION from spec:
 *   - Auth.js v5 beta does NOT export a top-level `NextAuthConfig` type from
 *     'next-auth' in the same way as earlier v5 alphas. We type the return
 *     value as `Parameters<typeof import('next-auth').default>[0]` to stay
 *     accurate, but use `any` escape for the config object to avoid importing
 *     NextAuth at this layer (which would create a hard next/server dependency
 *     in packages/api). The frontend-engineer passes the config to NextAuth()
 *     which performs the final type-check in apps/web.
 *   - `session.maxAge` is expressed in seconds: 60 * 60 * 8 = 28800 (8 hours).
 */
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import { getDb } from '../db.js';
import { verifyLoginAndIssueClaims } from './verify-login.js';

// ─── Re-export edge-safe callbacks and edge config ───────────────────────────
//
// jwtCallback, sessionCallback, and buildEdgeAuthConfig live in edge-callbacks.ts
// (a separate file with ZERO db/argon2 imports). auth-config.ts re-exports them
// so callers can import from either the auth barrel or auth-config.ts directly.
//
// The full buildAuthConfig() REUSES jwtCallback and sessionCallback imported from
// edge-callbacks.ts — same function references, cannot drift.
export {
  jwtCallback,
  sessionCallback,
  buildEdgeAuthConfig,
} from './edge-callbacks.js';
import { jwtCallback, sessionCallback } from './edge-callbacks.js';

// ─── Input validation schema ──────────────────────────────────────────────────

/**
 * loginSchema — validates the credentials passed to the Credentials provider.
 *
 * - slug:     the org's URL slug (non-empty string, trimmed)
 * - email:    email address (zod's email validator)
 * - password: non-empty string (length validated server-side only — no leaking)
 *
 * All three fields must be present; missing/invalid input returns null
 * (auth failure) rather than an error to avoid leaking input validation state.
 *
 * Exported so the mobile login route and verifyLoginAndIssueClaims can reuse
 * the SAME schema — never reimplemented.
 */
export const loginSchema = z.object({
  slug: z.string().min(1).trim(),
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(1),
});

// ─── Full auth config factory ─────────────────────────────────────────────────

/**
 * buildAuthConfig — constructs the NextAuth configuration object.
 *
 * Call this once at app startup (e.g. in apps/web/auth.ts) and pass the
 * result directly to NextAuth(). No db argument is required — the production
 * DB client is obtained lazily inside the authorize callback via getDb().
 *
 * Throws at call time (not at request time) if AUTH_SECRET is unset —
 * mirrors createProdClient's fail-fast pattern for env vars.
 *
 * The jwt and session callbacks are REUSED from the edge-safe exports above
 * (jwtCallback / sessionCallback) so the full and edge configs can never drift
 * in their session field projection.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildAuthConfig(): any {
  // Fail-fast if AUTH_SECRET is missing — do NOT let the app start without it.
  const secret = process.env['AUTH_SECRET'];
  if (!secret) {
    throw new Error(
      '[buildAuthConfig] AUTH_SECRET environment variable is not set. ' +
        'Set it in .env (see .env.example) — never hardcode the secret. ' +
        'Generate a value with: openssl rand -base64 32',
    );
  }

  return {
    secret,

    // ─── Providers ────────────────────────────────────────────────────────────
    providers: [
      Credentials({
        /**
         * authorize — validates login credentials and returns the user object
         * that Auth.js will embed in the JWT on sign-in.
         *
         * Returns null on any auth failure (invalid input, org not found,
         * suspended org, bad password, no membership). Never throws for
         * auth failures — only for infrastructure errors.
         *
         * The returned object is passed into callbacks.jwt as `user`.
         * It must include `id` (Auth.js canonical field) plus our custom fields.
         */
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async authorize(credentials: any): Promise<any> {
          // Step 1: Validate input shape.
          const parsed = loginSchema.safeParse(credentials);
          if (!parsed.success) {
            return null;
          }

          // Step 2: Obtain the DB client lazily (memoized — resolves instantly
          //   after the first successful connection).
          const db = await getDb();

          // Step 3–6: Shared login pipeline (resolveOrgBySlug → status==='active'
          //   → verifyCredential). Returns claims on success, null on any failure.
          const claims = await verifyLoginAndIssueClaims(db, parsed.data);
          if (!claims) {
            return null;
          }

          // Return the user object for Auth.js to embed in the JWT.
          // `id` is Auth.js's canonical user identifier field (maps to userId).
          return {
            id: claims.userId,
            orgId: claims.orgId,
            slug: claims.slug,
            role: claims.role,
            email: claims.email,
          };
        },
      }),
    ],

    // ─── Session ──────────────────────────────────────────────────────────────
    session: {
      strategy: 'jwt' as const,
      maxAge: 60 * 60 * 8, // 8 hours in seconds
    },

    // ─── Callbacks (reuse edge-safe implementations) ──────────────────────────
    callbacks: {
      /**
       * jwt — called when the JWT is created (sign-in) or read (request).
       *
       * On sign-in (trigger === 'signIn'), `user` is the object returned
       * by authorize(). Copy our custom fields into the token so they
       * persist across requests.
       *
       * On subsequent requests, `user` is undefined — the token already
       * contains our fields, so we just pass it through.
       *
       * Uses the shared jwtCallback (exported above) so this cannot drift
       * from the edge config's JWT callback.
       */
      jwt: jwtCallback,

      /**
       * session — called when the session is read (every authenticated request).
       *
       * Projects the JWT fields onto the session object so that
       * apps/web's `auth()` helper returns the AppSession shape.
       *
       * password_hash is NEVER on the token and therefore never on the session.
       *
       * Uses the shared sessionCallback (exported above) so this cannot drift
       * from the edge config's session callback.
       */
      session: sessionCallback,
    },

    // ─── Trust host ───────────────────────────────────────────────────────────
    // Required when running behind a reverse proxy (e.g. Vercel, Railway, nginx).
    // Also needed in local dev where the origin may not be HTTPS.
    trustHost: true,
  };
}
