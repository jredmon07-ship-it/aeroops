/**
 * demo-reset.test.ts — integration suite for the public-demo "reset-on-open"
 * safety feature (packages/api/src/demo/reset.ts).
 *
 * COVERAGE:
 *   1. HARD GUARD: resetDemoTenantWithDb THROWS for a non-allowlisted slug,
 *      before any DB work (a bug here could wipe a real customer).
 *   2. FLAG GATE: maybeResetDemoTenant is a no-op (never touches the DB) when
 *      AEROOPS_DEMO_RESET_ENABLED is unset, or when the slug is not allowlisted.
 *   3. RESET RESTORES BASELINE: seed alpha → mutate (create a marker reservation)
 *      → resetDemoTenantWithDb('alpha') → the mutation is gone, the seeded data
 *      is back, the reservation count returns to baseline, and the
 *      owner@alpha.aero / demo1234 credential still authenticates against the
 *      freshly re-seeded org (new org_id).
 *   4. THROTTLE: a second immediate reset is skipped ({ reset: false }).
 *
 * Setup mirrors the demo bootstrap: createTestClient() → apply ALL migrations
 * (0000…latest, including 0020_demo_reset_state) → seedDemo(). The client stays
 * a PGlite superuser (we do NOT setTestAppRole) because the reset's scoped
 * `DELETE FROM org` + re-seed run on the elevated owner connection in production.
 *
 * CAVEAT — superuser masks RLS: production's owner role (Neon neondb_owner) is
 * a NON-superuser bound by FORCE RLS, while the PGlite superuser bypasses RLS
 * unconditionally. Test 5 therefore re-runs the reset under a dedicated
 * non-superuser, non-owner role (GRANTs only) so the org_delete policy path the
 * production reset actually takes is exercised — this is the test that fails if
 * the reset forgets to scope the org GUCs before the wipe.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestClient, applyMigrationSql } from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';
import type { PGlite } from '@electric-sql/pglite';

import { seedDemo, DEMO_SLUG, DEMO_SLUG_BRAVO, DEMO_PASSWORD } from '../demo/seed.js';
import {
  resetDemoTenantWithDb,
  maybeResetDemoTenant,
} from '../demo/reset.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { verifyLoginAndIssueClaimsWithDb } from '../auth/verify-login.js';
import type { AppSession } from '../auth/types.js';
import { extractRows } from '../db-rows.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../db/migrations');

/** All up-migrations in numeric order (mirrors demo/bootstrap.ts readMigrations). */
function readAllMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
}

/** Count reservations belonging to the alpha org (superuser read — RLS bypassed). */
async function countAlphaReservations(db: PgliteTestClient): Promise<number> {
  const rows = extractRows<{ n: number }>(
    await db.execute(sql`
      select count(*)::int as n
      from reservation r
      join org o on o.id = r.org_id
      where o.slug = ${DEMO_SLUG}
    `),
  );
  return rows[0]?.n ?? 0;
}

/** How many reservations carry the given note in the alpha org. */
async function countAlphaReservationsWithNote(
  db: PgliteTestClient,
  note: string,
): Promise<number> {
  const rows = extractRows<{ n: number }>(
    await db.execute(sql`
      select count(*)::int as n
      from reservation r
      join org o on o.id = r.org_id
      where o.slug = ${DEMO_SLUG} and r.notes = ${note}
    `),
  );
  return rows[0]?.n ?? 0;
}

const MARKER_NOTE = '__reset_test_marker__';

describe('demo reset-on-open — hard safety guard', () => {
  let db: PgliteTestClient;

  beforeAll(async () => {
    const client = await createTestClient();
    db = client.db;
    await applyMigrationSql({ pglite: client.pglite as PGlite }, readAllMigrations());
  });

  it('THROWS when resetting a non-allowlisted slug (before any DB work)', async () => {
    await expect(
      resetDemoTenantWithDb(db, 'some-real-flight-school'),
    ).rejects.toThrow(/non-allowlisted/i);
  });

  it('maybeResetDemoTenant is a no-op when the feature flag is unset', async () => {
    const prev = process.env['AEROOPS_DEMO_RESET_ENABLED'];
    delete process.env['AEROOPS_DEMO_RESET_ENABLED'];
    try {
      // No AEROOPS_DEMO_OWNER_URL, no DB touched — must simply skip.
      await expect(maybeResetDemoTenant('alpha')).resolves.toEqual({ reset: false });
    } finally {
      if (prev !== undefined) process.env['AEROOPS_DEMO_RESET_ENABLED'] = prev;
    }
  });

  it('maybeResetDemoTenant is a no-op for a non-allowlisted slug even when enabled', async () => {
    const prev = process.env['AEROOPS_DEMO_RESET_ENABLED'];
    process.env['AEROOPS_DEMO_RESET_ENABLED'] = '1';
    try {
      await expect(
        maybeResetDemoTenant('some-real-flight-school'),
      ).resolves.toEqual({ reset: false });
    } finally {
      if (prev === undefined) delete process.env['AEROOPS_DEMO_RESET_ENABLED'];
      else process.env['AEROOPS_DEMO_RESET_ENABLED'] = prev;
    }
  });
});

describe('demo reset-on-open — wipe + re-seed restores baseline', () => {
  let db: PgliteTestClient;
  let baseline: number;

  beforeAll(async () => {
    const client = await createTestClient();
    db = client.db;
    await applyMigrationSql({ pglite: client.pglite as PGlite }, readAllMigrations());
    await seedDemo(db);
    baseline = await countAlphaReservations(db);
  });

  it('seeds a non-trivial baseline', () => {
    expect(baseline).toBeGreaterThan(0);
  });

  it('resets away a visitor mutation and restores the seeded state', async () => {
    // ── Resolve org + owner + a policy-free aircraft for the mutation ────────
    const info = extractRows<{ org_id: string; owner_id: string; res_id: string }>(
      await db.execute(sql`
        select o.id as org_id, u.id as owner_id, r.id as res_id
        from org o
        join app_user u on u.org_id = o.id and u.email = 'owner@alpha.aero'
        join resource r on r.org_id = o.id and r.tail_number = 'N152AB'
        where o.slug = ${DEMO_SLUG}
        limit 1
      `),
    )[0];
    expect(info).toBeTruthy();

    const ownerSession: AppSession = {
      user: { email: 'owner@alpha.aero' },
      userId: info!.owner_id,
      orgId: info!.org_id,
      slug: DEMO_SLUG,
      role: 'owner',
    };

    // ── MUTATE: create a marker reservation 30 days out (daytime, no conflict) ─
    const start = new Date();
    start.setDate(start.getDate() + 30);
    start.setHours(14, 0, 0, 0);
    const end = new Date(start);
    end.setHours(15, 0, 0, 0);

    const created = await createReservationWithDb(db, ownerSession, {
      startAt: start,
      endAt: end,
      resourceIds: [info!.res_id],
      notes: MARKER_NOTE,
    });
    expect(created.ok).toBe(true);

    expect(await countAlphaReservationsWithNote(db, MARKER_NOTE)).toBe(1);
    expect(await countAlphaReservations(db)).toBe(baseline + 1);

    // ── RESET ────────────────────────────────────────────────────────────────
    const result = await resetDemoTenantWithDb(db, DEMO_SLUG);
    expect(result).toEqual({ reset: true });

    // ── ASSERT the visitor mutation is gone and the baseline is restored ──────
    expect(await countAlphaReservationsWithNote(db, MARKER_NOTE)).toBe(0);
    expect(await countAlphaReservations(db)).toBe(baseline);

    // A known seeded reservation is present again in the fresh org.
    expect(await countAlphaReservationsWithNote(db, 'Solo pattern work')).toBe(1);

    // ── ASSERT the owner credential still authenticates (seed recreated it) ───
    const claims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: DEMO_SLUG,
      email: 'owner@alpha.aero',
      password: DEMO_PASSWORD,
    });
    expect(claims).not.toBeNull();
    expect(claims?.role).toBe('owner');
  });

  it('throttles a second immediate reset (skips within the interval window)', async () => {
    const result = await resetDemoTenantWithDb(db, DEMO_SLUG);
    expect(result).toEqual({ reset: false });
  });
});

describe('demo reset-on-open — works under a NON-superuser role bound by FORCE RLS', () => {
  let db: PgliteTestClient;
  let pglite: PGlite;

  beforeAll(async () => {
    const client = await createTestClient();
    db = client.db;
    pglite = client.pglite as PGlite;
    await applyMigrationSql({ pglite }, readAllMigrations());
    await seedDemo(db);
  });

  it('wipes + re-seeds as a non-superuser, non-owner role (the production RLS path)', async () => {
    // Production's owner role (Neon neondb_owner) is a NON-superuser: FORCE RLS
    // binds it, so the org_delete policy (`id = current_org_id`, no
    // platform-admin arm) applies to the reset's DELETE. The PGlite superuser
    // bypasses RLS unconditionally and cannot exercise that path — so run the
    // reset as a role with GRANTs but no superuser/ownership/BYPASSRLS.
    // Without the GUC-scoping in resetDemoTenantWithDb, the DELETE silently
    // matches 0 rows and the re-seed's org insert violates org_slug_unique.
    const orgIdBefore = extractRows<{ id: string }>(
      await db.execute(sql`select id from org where slug = ${DEMO_SLUG}`),
    )[0]?.id;
    expect(orgIdBefore).toBeTruthy();

    await pglite.exec(`
      CREATE ROLE demo_owner_rls_test LOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO demo_owner_rls_test;
      GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO demo_owner_rls_test;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO demo_owner_rls_test;
      SET ROLE demo_owner_rls_test;
    `);
    try {
      // Clear the throttle row left by earlier activity so this reset runs.
      // (RESET ROLE first would defeat the point — delete it via the role's
      // own GRANT instead; demo_reset_state has no RLS.)
      await db.execute(sql`DELETE FROM demo_reset_state WHERE slug = ${DEMO_SLUG}`);

      const result = await resetDemoTenantWithDb(db, DEMO_SLUG);
      expect(result).toEqual({ reset: true });
    } finally {
      await pglite.exec(`RESET ROLE;`);
    }

    // The DELETE really removed the old org (a filtered 0-row DELETE would
    // have made the seed's org insert violate org_slug_unique and roll the
    // whole reset back): the surviving alpha org is a NEW row...
    const orgIdAfter = extractRows<{ id: string }>(
      await db.execute(sql`select id from org where slug = ${DEMO_SLUG}`),
    )[0]?.id;
    expect(orgIdAfter).toBeTruthy();
    expect(orgIdAfter).not.toBe(orgIdBefore);

    // ...and it authenticates with the seeded credential.
    const claims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: DEMO_SLUG,
      email: 'owner@alpha.aero',
      password: DEMO_PASSWORD,
    });
    expect(claims).not.toBeNull();
  });
});

// ─── Bravo Flying Club — the second demo org (small club, club mode) ────────

describe('demo seed — Bravo Flying Club (second demo org)', () => {
  let db: PgliteTestClient;
  let pglite: PGlite;

  beforeAll(async () => {
    const client = await createTestClient();
    db = client.db;
    pglite = client.pglite;
    for (const migration of readAllMigrations()) {
      await applyMigrationSql({ pglite }, migration);
    }
    await seedDemo(db);
  }, 120_000);

  it('seeds BOTH demo orgs exactly once', async () => {
    const rows = extractRows<{ slug: string; n: number }>(
      await db.execute(sql`
        select slug, count(*)::int as n from org
        where slug in (${DEMO_SLUG}, ${DEMO_SLUG_BRAVO})
        group by slug order by slug
      `),
    );
    expect(rows).toEqual([
      { slug: DEMO_SLUG, n: 1 },
      { slug: DEMO_SLUG_BRAVO, n: 1 },
    ]);
  });

  it('bravo has exactly 2 aircraft and the 3 demo logins with the right roles', async () => {
    const aircraft = extractRows<{ n: number }>(
      await db.execute(sql`
        select count(*)::int as n
        from resource r join org o on o.id = r.org_id
        where o.slug = ${DEMO_SLUG_BRAVO} and r.kind = 'aircraft'
      `),
    );
    expect(aircraft[0]?.n).toBe(2);

    const users = extractRows<{ email: string; role: string }>(
      await db.execute(sql`
        select u.email, m.role
        from app_user u
        join membership m on m.user_id = u.id and m.org_id = u.org_id
        join org o on o.id = u.org_id
        where o.slug = ${DEMO_SLUG_BRAVO}
        order by u.email
      `),
    );
    expect(users).toEqual([
      { email: 'admin@bravo.aero', role: 'manager' },
      { email: 'member@bravo.aero', role: 'renter' },
      { email: 'owner@bravo.aero', role: 'owner' },
    ]);
  });

  it('bravo is in CLUB mode with training/booking/auto-schedule off (0047 applied here)', async () => {
    const rows = extractRows<{
      operating_mode: string;
      module_training: boolean;
      module_booking: boolean;
      module_auto_schedule: boolean;
      module_billing: boolean;
      module_maintenance: boolean;
      module_portal: boolean;
    }>(
      await db.execute(sql`
        select f.operating_mode, f.module_training, f.module_booking,
               f.module_auto_schedule, f.module_billing, f.module_maintenance, f.module_portal
        from org_feature_config f join org o on o.id = f.org_id
        where o.slug = ${DEMO_SLUG_BRAVO}
      `),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operating_mode: 'club',
      module_training: false,
      module_booking: false,
      module_auto_schedule: false,
      module_billing: true,
      module_maintenance: true,
      module_portal: true,
    });
  });

  it('bravo demo users carry seeded avatars (0048 applied here)', async () => {
    const rows = extractRows<{ n: number }>(
      await db.execute(sql`
        select count(*)::int as n
        from app_user u join org o on o.id = u.org_id
        where o.slug = ${DEMO_SLUG_BRAVO}
          and u.avatar_data like 'data:image/png;base64,%'
      `),
    );
    expect(rows[0]?.n).toBe(3);
  });

  it('all three bravo credentials authenticate with the shared demo password', async () => {
    for (const email of ['owner@bravo.aero', 'admin@bravo.aero', 'member@bravo.aero']) {
      const claims = await verifyLoginAndIssueClaimsWithDb(db, {
        slug: DEMO_SLUG_BRAVO,
        email,
        password: DEMO_PASSWORD,
      });
      expect(claims, `${email} should authenticate`).not.toBeNull();
    }
  });

  it("resetting 'bravo' is allowlisted and rebuilds BOTH demo orgs exactly once", async () => {
    const r = await resetDemoTenantWithDb(db, DEMO_SLUG_BRAVO);
    expect(r.reset).toBe(true);
    const rows = extractRows<{ slug: string; n: number }>(
      await db.execute(sql`
        select slug, count(*)::int as n from org
        where slug in (${DEMO_SLUG}, ${DEMO_SLUG_BRAVO})
        group by slug order by slug
      `),
    );
    expect(rows).toEqual([
      { slug: DEMO_SLUG, n: 1 },
      { slug: DEMO_SLUG_BRAVO, n: 1 },
    ]);
  });
});
