/** @type {import('next').NextConfig} */

// ─── Build-phase-only env guard ───────────────────────────────────────────────
// AUTH_SECRET must be set at runtime. During `next build` (CI/CD environments
// where the real secret is intentionally absent), we set a dummy value ONLY
// when NEXT_PHASE === 'phase-production-build' so the build-time module graph
// can be evaluated without a real secret.
//
// CRITICAL: This guard MUST NOT fire at runtime (server start / request time).
// Next.js sets NEXT_PHASE='phase-production-build' exclusively during `next build`;
// it is undefined at runtime. A missing AUTH_SECRET at runtime must cause
// buildAuthConfig() / the runtime assertion in auth.ts to throw (fail-loud).
//
// DATABASE_URL is not set at build time — no DB connection is made during build.
// Pages that call getDb() are server components / server actions and are only
// executed at request time (not during static generation in this app).
const BUILD_PHASE_PLACEHOLDER =
  'build-time-placeholder-not-a-real-secret-replace-me';

if (
  !process.env.AUTH_SECRET &&
  process.env.NEXT_PHASE === 'phase-production-build'
) {
  process.env.AUTH_SECRET = BUILD_PHASE_PLACEHOLDER;
}

const nextConfig = {
  // Only transpile @aeroops/core (pure TS, no native binaries, edge-safe).
  // @aeroops/api and @aeroops/db are kept as serverExternalPackages:
  // they contain native binaries (@node-rs/argon2) and pglite (WebAssembly)
  // which cannot be bundled by webpack or run in Edge Runtime.
  transpilePackages: ['@aeroops/core'],

  // Exclude packages with native binaries / WebAssembly from the webpack bundle.
  // These are required by Node.js at runtime rather than bundled.
  serverExternalPackages: [
    '@aeroops/api',
    '@aeroops/db',
    '@node-rs/argon2',
    '@electric-sql/pglite',
    'drizzle-orm',
  ],

  webpack(config, { isServer }) {
    // The workspace packages (@aeroops/*) use TypeScript source as their
    // entrypoint (main: "./src/index.ts") and write internal imports with
    // .js extensions (ESM convention with "moduleResolution": "Bundler").
    // webpack needs to resolve .js extension imports to their .ts equivalents.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.jsx': ['.tsx', '.jsx'],
    };

    if (isServer) {
      // Exclude packages with native binaries from the webpack bundle.
      // They are required at runtime by Node.js via the standard require mechanism.
      // This works for packages resolved via tsconfig path aliases (local workspace
      // source files) where serverExternalPackages by package name alone is not enough.
      const existingExternals = Array.isArray(config.externals)
        ? config.externals
        : config.externals
          ? [config.externals]
          : [];

      config.externals = [
        ...existingExternals,
        function (context, callback) {
          const request = context.request;
          // Externalize native binary packages so webpack doesn't bundle them
          if (
            request === '@node-rs/argon2' ||
            request.startsWith('@node-rs/argon2/') ||
            request === '@electric-sql/pglite' ||
            request.startsWith('@electric-sql/pglite/')
          ) {
            return callback(null, 'commonjs ' + request);
          }
          callback();
        },
      ];
    }

    return config;
  },
};

export default nextConfig;
