/**
 * auth-edge.ts — Minimal Auth.js instance for Edge Runtime (middleware).
 *
 * EDGE BUNDLE SAFETY:
 *   This file imports buildEdgeAuthConfig directly from the source path
 *   (../../packages/api/src/auth/edge-callbacks.ts via tsconfig alias), NOT
 *   via the '@aeroops/api' barrel. This is critical because '@aeroops/api' is
 *   listed in serverExternalPackages (it contains @node-rs/argon2 which is a
 *   native binary incompatible with Edge Runtime). Importing via the barrel
 *   could cause Next.js to attempt to bundle native deps for the edge.
 *
 *   edge-callbacks.ts has ZERO db/argon2/pglite/drizzle imports — it contains
 *   only pure field-copy functions (jwtCallback, sessionCallback) and
 *   buildEdgeAuthConfig (which only reads process.env and returns a plain object).
 *
 * WHY buildEdgeAuthConfig (not inline config):
 *   Auth.js v5 JWT strategy reads session fields from the token via the session
 *   callback. Without the session callback, the middleware's `req.auth` only
 *   exposes `user` + `expires` — our custom fields (userId, orgId, slug, role)
 *   are missing, making the session.userId check in middleware.ts always falsy
 *   and redirecting every authenticated user to login.
 *
 *   buildEdgeAuthConfig supplies the SAME jwt+session callbacks (same function
 *   references as buildAuthConfig) so middleware can read all custom fields.
 *
 * AUTH_SECRET must be identical in both auth.ts and auth-edge.ts so the JWT
 * signed by the full auth config can be verified by the edge config.
 */
import NextAuth from 'next-auth';
import { buildEdgeAuthConfig } from '@aeroops/api/auth/edge-callbacks.js';

export const { auth } = NextAuth(buildEdgeAuthConfig());
