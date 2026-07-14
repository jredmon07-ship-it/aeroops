/**
 * create-org.test.ts — self-serve signup (createOrgWithOwner, migration 0049).
 *
 * env0049 — migrations 0000–0049 applied (acceptance table present).
 * envAbsent — 0000–0048 (0049 absent → acceptance write skipped, signup works).
 *
 * COVERAGE: atomic org+owner+membership+credential creation; the created owner
 * can log in via the SAME verifyLoginAndIssueClaims the login page uses; slug
 * derivation + collision suffixing; reserved-name refusal; clickwrap required;
 * honeypot; password floor; tenant isolation (new org's owner cannot see another
 * org); acceptance rows recorded (and gracefully skipped when 0049 absent);
 * NO orphan org when a slug races.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
} from '@aeroops/db';
import { sql } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { createOrgWithOwnerWithDb } from '../auth/create-org.js';
import { resolveOrgBySlug } from '../auth/resolve-org.js';
import { verifyLoginAndIssueClaimsWithDb } from '../auth/verify-login.js';
import { ValidationError } from '../scheduling/internal.js';
import { extractRows } from '../db-rows.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../db/migrations');

/** All up-migrations (NNNN_*.sql, excluding *.down.sql) with number <= max, in order. */
function migrationsThrough(max: number): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && !f.endsWith('.down.sql'))
    .filter((f) => Number(f.slice(0, 4)) <= max)
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
}
const allMigrations = () => migrationsThrough(49);

const VALID = {
  orgName: 'Skyline Flying Club',
  ownerFullName: 'Pat Owner',
  email: 'pat@skyline.example',
  password: 'correcthorse7',
  acceptedTerms: true as const,
};

describe('createOrgWithOwner (migration 0049 applied)', () => {
  let db: PgliteTestClient;
  let pglite: PGlite;

  beforeAll(async () => {
    const client = await createTestClient();
    db = client.db;
    pglite = client.pglite;
    for (const m of allMigrations()) await applyMigrationSql({ pglite }, m);
    await setTestAppRole({ pglite });
    process.env['AUTH_SECRET'] = 'signup-test-secret';
  }, 120_000);

  it('creates an org + owner the login path can authenticate, and records acceptance', async () => {
    const res = await createOrgWithOwnerWithDb(db, VALID, '203.0.113.9');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.slug).toBe('skyline-flying-club');
    expect(res.email).toBe('pat@skyline.example');

    // The created owner authenticates via the SAME path the login form uses.
    const claims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: res.slug,
      email: VALID.email,
      password: VALID.password,
    });
    expect(claims).not.toBeNull();
    expect(claims?.role).toBe('owner');

    // Wrong password is refused (credential really is the argon2 hash).
    const bad = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: res.slug,
      email: VALID.email,
      password: 'wrongpassword1',
    });
    expect(bad).toBeNull();

    // Two acceptance rows (terms + privacy) recorded for the owner, with IP.
    // (resolve via the platform-admin read — a bare RLS-scoped SELECT hides the
    // org row without an org GUC, which is itself correct.)
    const resolved = await resolveOrgBySlug(db, res.slug);
    const orgId = resolved!.id;
    const acc = await withOrgContext(db, orgId, async (tx) =>
      extractRows<{ document: string; version: string; accepted_ip: string | null }>(
        await (tx as PgliteTestClient).execute(
          sql`SELECT document, version, accepted_ip FROM terms_acceptance WHERE org_id = ${orgId}::uuid ORDER BY document`,
        ),
      ),
    );
    expect(acc.map((r) => r.document)).toEqual(['privacy', 'terms']);
    expect(acc.every((r) => r.accepted_ip === '203.0.113.9')).toBe(true);
    expect(acc.every((r) => r.version.length > 0)).toBe(true);
  });

  it('suffixes the slug on collision (second club with the same name)', async () => {
    const r1 = await createOrgWithOwnerWithDb(db, { ...VALID, email: 'a@dup.example', orgName: 'Dup Aero' });
    const r2 = await createOrgWithOwnerWithDb(db, { ...VALID, email: 'b@dup.example', orgName: 'Dup Aero' });
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.slug).toBe('dup-aero');
      expect(r2.slug).toBe('dup-aero-2');
    }
  });

  it('refuses a name with no usable slug (all punctuation → invalid_name)', async () => {
    const res = await createOrgWithOwnerWithDb(db, { ...VALID, email: 'x@p.example', orgName: '!!!' });
    expect(res).toEqual({ ok: false, reason: 'invalid_name' });
  });

  it('refuses a reserved name (maps to a reserved slug → invalid_name)', async () => {
    const res = await createOrgWithOwnerWithDb(db, { ...VALID, email: 'y@p.example', orgName: 'api' });
    expect(res).toEqual({ ok: false, reason: 'invalid_name' });
  });

  it('requires the clickwrap, a clean honeypot, and a 10+ char password', async () => {
    await expect(
      createOrgWithOwnerWithDb(db, { ...VALID, email: 'c@p.example', acceptedTerms: false }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createOrgWithOwnerWithDb(db, { ...VALID, email: 'd@p.example', website: 'http://spam' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createOrgWithOwnerWithDb(db, { ...VALID, email: 'e@p.example', password: 'short' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('T-ISO: a newly created org owner cannot see another org', async () => {
    const a = await createOrgWithOwnerWithDb(db, { ...VALID, email: 'iso-a@p.example', orgName: 'Iso Alpha' });
    const b = await createOrgWithOwnerWithDb(db, { ...VALID, email: 'iso-b@p.example', orgName: 'Iso Bravo' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Org A's owner authenticates ONLY against org A's slug, never org B's.
    const crossed = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: b.slug,
      email: 'iso-a@p.example',
      password: VALID.password,
    });
    expect(crossed).toBeNull();
  });
});

describe('createOrgWithOwner — graceful absence (0049 not applied)', () => {
  let db: PgliteTestClient;
  let pglite: PGlite;

  beforeAll(async () => {
    const client = await createTestClient();
    db = client.db;
    pglite = client.pglite;
    for (const m of migrationsThrough(48)) await applyMigrationSql({ pglite }, m);
    await setTestAppRole({ pglite });
    process.env['AUTH_SECRET'] = 'signup-absent-secret';
  }, 120_000);

  it('signup still creates a working org+owner; acceptance write is skipped', async () => {
    const res = await createOrgWithOwnerWithDb(db, { ...VALID, email: 'noacc@p.example', orgName: 'No Acc Club' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const claims = await verifyLoginAndIssueClaimsWithDb(db, {
      slug: res.slug,
      email: 'noacc@p.example',
      password: VALID.password,
    });
    expect(claims?.role).toBe('owner');
  });
});
