/**
 * scripts/demo.mjs — zero-setup demo launcher.
 *
 * Boots the REAL Next.js app against an in-process PGlite database (no Docker,
 * no Postgres install, no DATABASE_URL). It just sets the demo env flags and
 * starts `next dev`; getDb() (packages/api) does the rest: create PGlite, apply
 * migrations 0000–0005, seed demo data, drop to the RLS-enforced app role.
 *
 * Usage:  pnpm demo
 *
 * NOTHING here touches a real database or applies a migration to one. The demo
 * flag (AEROOPS_DEMO=1) is the only switch that activates the in-memory path.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const migrationsDir = resolve(repoRoot, 'packages/db/migrations');

const env = {
  ...process.env,
  AEROOPS_DEMO: '1',
  AEROOPS_DEMO_MIGRATIONS_DIR: migrationsDir,
  // A throwaway secret is fine for a local demo: it only signs the local JWT.
  // Generated fresh each run unless the operator already exported one.
  AUTH_SECRET: process.env.AUTH_SECRET || randomBytes(32).toString('base64'),
  // Auth.js needs a trusted host for local callbacks.
  AUTH_TRUST_HOST: 'true',
  NODE_ENV: 'development',
};

const PORT = process.env.PORT || '3000';

console.log('');
console.log('  ✈  AeroOps demo');
console.log('  ─────────────────────────────────────────────');
console.log('  Starting the app on an in-memory database…');
console.log('');
console.log(`  Alpha Flight School:  http://localhost:${PORT}/o/alpha/login`);
console.log('  Logins (password: demo1234):');
console.log('    owner@alpha.aero      — full access (owner)');
console.log('    dispatch@alpha.aero   — dispatcher');
console.log('    cfi@alpha.aero        — instructor');
console.log('    student@alpha.aero    — student (read-only feel)');
console.log('');
console.log(`  Buckeye Flying Club (small club):  http://localhost:${PORT}/o/buckeye/login`);
console.log('  Logins (password: demo1234):');
console.log('    owner@buckeye.aero    — club president (owner)');
console.log('    admin@buckeye.aero    — scheduler (manager)');
console.log('    member@buckeye.aero   — member (renter)');
console.log('');
console.log('  See DEMO.md for the click-through.');
console.log('  ─────────────────────────────────────────────');
console.log('');

const child = spawn('pnpm', ['--filter', '@aeroops/web', 'dev', '--port', PORT], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
});

// WARM-UP: the very first request pays for the PGlite bootstrap + dual-org
// seed (~10s) inside the request, and Next dev's first compile can trip a
// harmless one-off worker error on that same request. Firing throwaway
// warm-up fetches here means the first HUMAN click always lands on a warm,
// fully-seeded server. Best-effort: any failure is retried, never fatal.
async function warmUp() {
  const urls = [
    `http://localhost:${PORT}/o/alpha/login`,
    `http://localhost:${PORT}/o/buckeye/login`,
  ];
  for (const url of urls) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const res = await fetch(url, { redirect: 'manual' });
        if (res.status < 500) break;
      } catch {
        // Server not accepting connections yet — retry.
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.log('');
  console.log('  ✓ Demo is warm — both orgs seeded and ready to click.');
  console.log('');
}
setTimeout(() => void warmUp(), 3000);

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
