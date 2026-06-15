/**
 * auth.ts — NextAuth instance for AeroOps web app.
 *
 * Initialises Auth.js with the shared config from @aeroops/api.
 * This is the single source of truth for the auth helpers used throughout
 * apps/web.
 *
 * Usage:
 *   import { auth, signIn, signOut } from '@/auth';
 *
 * The `handlers` export is re-exported from app/api/auth/[...nextauth]/route.ts
 * as GET/POST to satisfy the Auth.js route handler convention.
 *
 * AUTH_SECRET must be set in .env.local (never committed). buildAuthConfig()
 * will throw at startup if AUTH_SECRET is missing.
 *
 * RUNTIME ASSERTION: We additionally check here (outside of buildAuthConfig)
 * that AUTH_SECRET is not the build-phase placeholder. If a misconfigured
 * production deploy somehow boots with the placeholder, we refuse to start —
 * the placeholder is a known value and could allow JWT forgery (cross-tenant
 * escalation). This guard fires at module-load time (i.e. before any request
 * is handled), so the process will crash loudly rather than serve requests
 * with a compromised secret.
 *
 * The check is skipped during `next build` (NEXT_PHASE === 'phase-production-build')
 * so that the build itself can complete with the dummy value.
 */
import NextAuth from 'next-auth';
import { buildAuthConfig } from '@aeroops/api';

const BUILD_PHASE_PLACEHOLDER =
  'build-time-placeholder-not-a-real-secret-replace-me';

if (process.env['NEXT_PHASE'] !== 'phase-production-build') {
  const secret = process.env['AUTH_SECRET'];
  if (!secret) {
    throw new Error(
      '[auth] AUTH_SECRET is not set. ' +
        'Set it in .env.local — never hardcode or commit the secret. ' +
        'Generate with: openssl rand -base64 32',
    );
  }
  if (secret === BUILD_PHASE_PLACEHOLDER) {
    throw new Error(
      '[auth] AUTH_SECRET is the build-time placeholder. ' +
        'This value must not be used at runtime — it is a known string and ' +
        'allows JWT forgery. Set a real secret in .env.local.',
    );
  }
}

export const { auth, handlers, signIn, signOut } = NextAuth(buildAuthConfig());
