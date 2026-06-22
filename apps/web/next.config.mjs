/** @type {import('next').NextConfig} */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirnameLocal = path.dirname(__filename);
// Monorepo root (…/Workflow - FBO SaaS), two levels up from apps/web.
const REPO_ROOT = path.join(__dirnameLocal, '..', '..');

// ─── Build-phase-only env guard ───────────────────────────────────────────────
// AUTH_SECRET must be set at runtime. During `next build` (local dev and CI/CD
// environments where the real secret may be absent from the Next.js project dir),
// we set a dummy value so the build-time module graph can be evaluated without
// a real secret.
//
// CRITICAL: next.config.mjs is evaluated BEFORE Next.js sets NEXT_PHASE, so we
// cannot rely on NEXT_PHASE to gate this. Instead we set a placeholder whenever
// AUTH_SECRET is missing. next.config.mjs is not re-evaluated at runtime (server
// start / request time) — the real runtime env comes from the deployment env or
// .env.local in the project root. auth.ts has a separate runtime assertion that
// rejects the placeholder value at request time, ensuring fail-loud behaviour if
// the server starts without a real secret.
//
// DATABASE_URL is not set at build time — no DB connection is made during build.
// Pages that call getDb() are server components / server actions and are only
// executed at request time (not during static generation in this app).
const BUILD_PHASE_PLACEHOLDER =
  'build-time-placeholder-not-a-real-secret-replace-me';

if (!process.env.AUTH_SECRET) {
  process.env.AUTH_SECRET = BUILD_PHASE_PLACEHOLDER;
}

const nextConfig = {
  // Trace files from the monorepo root — under pnpm, deps live in the
  // repo-root node_modules/.pnpm store, outside apps/web.
  outputFileTracingRoot: REPO_ROOT,
  // Force-include @electric-sql/pglite (the WASM demo/TEST database) in the
  // serverless functions. It is externalized (require'd at runtime, see the
  // webpack externals below) but only ever EXECUTED when AEROOPS_DEMO=1. webpack
  // still emits the require() in a shared server chunk, so without the package
  // files present the function 500s with "Cannot find module '@electric-sql/pglite'"
  // on EVERY route. Including the files makes the require resolve (harmless — the
  // module is never instantiated in production).
  outputFileTracingIncludes: {
    '/**': [
      'node_modules/.pnpm/@electric-sql+pglite@*/node_modules/@electric-sql/pglite/**',
      // @node-rs/argon2 (native Rust .node addon) is used in production for
      // password verification — it is externalized but nft misses it the same
      // way it missed pglite. Include the meta-package AND the platform-specific
      // binary subpackages (the glob matches whatever the build OS installed —
      // the linux-x64-gnu binary on Vercel). Without it: "Cannot find module
      // '@node-rs/argon2'" 500s on every auth/DB route.
      'node_modules/.pnpm/@node-rs+argon2*/node_modules/@node-rs/**',
    ],
  },

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
