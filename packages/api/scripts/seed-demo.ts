/**
 * seed-demo.ts — Demo seed runner for a real Postgres database.
 *
 * Run via pnpm db:seed:demo (invokes this file with tsx in the @aeroops/api
 * package context so tsconfig path aliases resolve correctly).
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  SAFETY GUARD                                                            ║
 * ║  Requires ALLOW_DEMO_SEED=1 in the environment. This prevents            ║
 * ║  accidentally seeding demo data into a real customer database.           ║
 * ║                                                                          ║
 * ║  DATABASE_URL must be the OWNER / DDL-role connection string             ║
 * ║  (NOT the aeroops_app runtime role). The seed uses                       ║
 * ║  withPlatformAdminContext + withOrgContext and creates auth credentials;  ║
 * ║  these operations require DDL-level access. The owner/superuser role      ║
 * ║  bypasses FORCE RLS during seeding — this is intentional (same contract  ║
 * ║  as the PGlite test seed). Once seeded, the running app connects as       ║
 * ║  aeroops_app for enforced RLS.                                           ║
 * ║                                                                          ║
 * ║  This seeds the SAME dataset as pnpm demo (in-memory PGlite, DEMO.md):  ║
 * ║    org:     Alpha Flight School (slug: alpha)                            ║
 * ║    users:   5 (one per role, each with password credential)              ║
 * ║    fleet:   N172SP / N152AB / N28K / N66RG + CFI resource               ║
 * ║    data:    today's reservations, dispatch tickets, booking policy,       ║
 * ║             weekly series, squawks, grounded Cirrus, dispatch gate,      ║
 * ║             civil-twilight config                                        ║
 * ║                                                                          ║
 * ║  Logins (password: demo1234) — see DEMO.md for the full click-through:  ║
 * ║    owner@alpha.aero  /  manager@alpha.aero  /  dispatch@alpha.aero       ║
 * ║    cfi@alpha.aero    /  student@alpha.aero                               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   DATABASE_URL=postgres://owner:pw@host/db ALLOW_DEMO_SEED=1 pnpm db:seed:demo
 *
 * Prerequisites:
 *   1. All migrations applied (pnpm db:migrate:apply).
 *   2. Target DB is empty — no existing org with slug "alpha".
 *   3. DATABASE_URL is the owner/DDL role (not aeroops_app).
 *
 * After seeding, configure the running app with the aeroops_app DATABASE_URL
 * (the non-superuser role created by migration 0000) so FORCE RLS is enforced.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@aeroops/db';
import { seedDemo, DEMO_LOGINS, DEMO_PASSWORD, DEMO_SLUG } from '../src/demo/seed.js';
import type { AnyDb } from '@aeroops/db';

// ── Environment guards ────────────────────────────────────────────────────────

const ALLOW_DEMO_SEED = process.env['ALLOW_DEMO_SEED'] === '1';
const DATABASE_URL = process.env['DATABASE_URL'];

if (!ALLOW_DEMO_SEED) {
  console.error('');
  console.error('  ERROR: ALLOW_DEMO_SEED=1 is required.');
  console.error('  This guard prevents accidentally seeding demo data into a real customer DB.');
  console.error('  To seed a hosted demo:');
  console.error('    ALLOW_DEMO_SEED=1 pnpm db:seed:demo');
  console.error('');
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error('');
  console.error('  ERROR: DATABASE_URL is not set.');
  console.error('  Provide the OWNER connection string (not aeroops_app):');
  console.error('    export DATABASE_URL="postgres://owner:password@host:5432/aeroops"');
  console.error('');
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const displayUrl = DATABASE_URL!.replace(/:([^@/]+)@/, ':***@');

  console.log('');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log('  AeroOps demo seed — real Postgres');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log(`  Target: ${displayUrl}`);
  console.log('');
  console.log('  Seeding Alpha Flight School demo dataset…');
  console.log('  (Identical to the in-memory pnpm demo, seeded via the real write paths.)');
  console.log('');

  // Connect as the owner/DDL role. We do NOT use createProdClient() because
  // that function asserts non-superuser (the RLS safety check). The seed NEEDS
  // superuser/owner access to insert control-plane rows (org/plan/subscription
  // via withPlatformAdminContext). This mirrors how PGlite tests run as
  // superuser during setup, then drop to aeroops_app for the running app.
  const pgClient = postgres(DATABASE_URL!, {
    max: 1,
    idle_timeout: 300,
    connect_timeout: 30,
  });
  const db = drizzle(pgClient, { schema }) as unknown as AnyDb;

  try {
    // Idempotency check: refuse if the demo org already exists.
    const existing = await pgClient<{ slug: string }[]>`
      SELECT slug FROM org WHERE slug = ${DEMO_SLUG} LIMIT 1
    `;
    if (existing.length > 0) {
      console.error(`  ERROR: org with slug "${DEMO_SLUG}" already exists.`);
      console.error('  The demo seed is not idempotent. To re-seed:');
      console.error('    DROP the database and re-provision, then re-run migrations + seed.');
      console.error('');
      await pgClient.end();
      process.exit(1);
    }

    // Run seedDemo — uses the real write paths (createReservationWithDb,
    // openDispatchWithDb, reportSquawkWithDb, etc.) so the demo data is
    // byte-identical to what the running app would produce. This is the
    // same contract as the PGlite bootstrap in packages/api/src/demo/bootstrap.ts.
    await seedDemo(db);

    console.log('');
    console.log('  ─────────────────────────────────────────────────────────');
    console.log('  Demo seed complete.');
    console.log('');
    console.log(`  Password for all accounts: ${DEMO_PASSWORD}`);
    console.log('');
    console.log('  Logins:');
    for (const login of DEMO_LOGINS) {
      console.log(`    ${login.email.padEnd(28)}  ${login.role}`);
    }
    console.log('');
    console.log(`  Login URL: https://your-domain/o/${DEMO_SLUG}/login`);
    console.log('');
    console.log('  IMPORTANT — app DATABASE_URL must be the aeroops_app role,');
    console.log('  NOT the owner role used here. The app must connect as the');
    console.log('  non-superuser aeroops_app so FORCE ROW LEVEL SECURITY is enforced.');
    console.log('  See DEPLOY.md for the full setup sequence.');
    console.log('  ─────────────────────────────────────────────────────────');
    console.log('');
  } finally {
    await pgClient.end();
  }
}

main().catch((e) => {
  console.error('');
  console.error('  FATAL: demo seed crashed.');
  console.error(`  ${(e as Error).message}`);
  if ((e as Error).stack) console.error((e as Error).stack);
  console.error('');
  process.exit(1);
});
