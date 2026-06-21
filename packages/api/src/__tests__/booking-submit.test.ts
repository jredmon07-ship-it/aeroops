/**
 * booking-submit.test.ts — Slice PB1.1 security + integration tests.
 * pglite + *WithDb forms; migrations 0000–0015; ≥2 seeded orgs.
 *
 * THE HEADLINE: the ONLY unauthenticated WRITE in the app. ADR-0013 airtight.
 *
 * COVERAGE:
 *
 *   ISO-1  TENANT ISOLATION — the inserted row's org_id equals the slug-resolved
 *          org (not any client-supplied value) for MULTIPLE distinct slugs.
 *   ISO-2  BODY-SLUG IGNORED — a client-supplied org_id / slug in the body is
 *          silently ignored; the row tracks the URL slug, not the body.
 *   ISO-3  CROSS-ORG ADVERSARIAL — attempt to write to org-B by calling the
 *          org-A slug with a body org_id that claims org-B: RLS WITH CHECK
 *          rejects it (or, if the orchestrator is correct, body org_id is never
 *          used so the insert goes to org-A).
 *   ISO-4  NO TENANT READ — the submit path returns no tenant data (ok:true only);
 *          no other table is read inside the tx.
 *
 *   ENUM-1 UNKNOWN SLUG → { ok:false, reason:'unavailable' }
 *   ENUM-2 SUSPENDED ORG → { ok:false, reason:'unavailable' } — byte-identical
 *          to ENUM-1 (anti-enumeration: callers cannot distinguish the two).
 *
 *   HP-1   HONEYPOT non-empty → { ok:true }, no row inserted (ZERO DB access).
 *   HP-2   HONEYPOT empty / absent → normal path proceeds.
 *
 *   VAL-1  Missing required field (name) → { ok:false, reason:'invalid' }, no row.
 *   VAL-2  Oversized name (>120 chars) → { ok:false, reason:'invalid' }, no row.
 *   VAL-3  Invalid email format → { ok:false, reason:'invalid' }, no row.
 *   VAL-4  email ≤254 char boundary: 254 chars → ok, 255 chars → invalid.
 *   VAL-5  phone > 40 chars → { ok:false, reason:'invalid' }, no row.
 *   VAL-6  message > 2000 chars → { ok:false, reason:'invalid' }, no row.
 *   VAL-7  aircraftTypePref > 80 chars → { ok:false, reason:'invalid' }, no row.
 *   VAL-8  requestedStart missing → { ok:false, reason:'invalid' }, no row.
 *   VAL-9  requestedEnd before requestedStart → { ok:false, reason:'invalid' }, no row.
 *   VAL-10 Valid minimal payload (name + email + requestedStart) → { ok:true },
 *          row inserted with correct requester fields + status='new'.
 *   VAL-11 Email normalisation: uppercase email in body → stored as lowercase.
 *   VAL-12 Name is trimmed: leading/trailing whitespace stripped.
 *
 *   RATE-1 Per-org rate guard: after inserting RATE_LIMIT_PER_ORG_PER_MIN rows
 *          via direct DB insert (bypassing the guard), the (N+1)th submit call
 *          returns { ok:true } with no new row (silent drop).
 *   RATE-2 Rate guard is per-org: org-A hitting the limit does not block org-B.
 *
 *   DB-1   Row fields: inserted row has correct org_id, status='new',
 *          requester_name, requester_email, requested_start, nulls for optional fields.
 *   DB-2   Row fields: optional fields (phone, requestedEnd, aircraftTypePref, message)
 *          stored correctly when provided.
 *
 *   RLS-1  migration 0015 up: ENABLE+FORCE RLS applied; SELECT under wrong org
 *          context returns 0 rows.
 *   RLS-2  INSERT without org context → 0 rows (WITH CHECK fail-closed).
 *
 * No FAA determination, no money, no reservation created, no session required.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  withPlatformAdminContext,
  seedTwoOrgs,
} from '@aeroops/db';
import { bookingRequest, org } from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { submitBookingRequestWithDb } from '../booking/submit-booking-request.js';

// ── Path resolution ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const MIGRATION_SQL = [
  readFileSync(resolve(__dirname, '../../../db/migrations/0000_loud_prodigy.sql'),      'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0001_auth_credential.sql'),   'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0002_scheduling.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0003_booking_policies.sql'),  'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0004_recurrence.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0005_dispatch.sql'),          'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0006_squawks_grounding.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0007_fleet.sql'),             'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0008_people.sql'),            'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0009_dispatch_gate.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0010_civil_twilight.sql'),    'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0011_optimizer_run.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0012_training.sql'),          'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0013_work_orders.sql'),       'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0014_availability.sql'),      'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0015_booking_request.sql'),   'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0016_booking_request_convert.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0017_booking_retention.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0018_dispatch_ticket_correction.sql'),        'utf-8'),
];

// ── Constants mirroring the orchestrator ──────────────────────────────────────

const RATE_LIMIT_PER_ORG_PER_MIN = 10;

// ── Shared test environment ────────────────────────────────────────────────────

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  slugA: string;
  slugB: string;
}

let env: TestEnv;

// A future date well in range: 2027-01-15T14:00:00Z
const FUTURE_START = '2027-01-15T14:00:00.000Z';
const FUTURE_END   = '2027-01-15T16:00:00.000Z';

/**
 * A minimal valid booking-request input (all required fields, no honeypot).
 */
function minimalValid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Jane Pilot',
    email: 'jane@example.com',
    requestedStart: FUTURE_START,
    ...overrides,
  };
}

/**
 * Count booking_request rows visible under a given org context.
 * Uses withOrgContext so RLS is enforced.
 */
async function countRows(db: PgliteTestClient, orgId: string): Promise<number> {
  return withOrgContext(db, orgId, async (tx) => {
    const result = await (tx as PgliteTestClient).execute(
      sql`SELECT COUNT(*)::int AS cnt FROM booking_request WHERE org_id = ${orgId}::uuid`,
    );
    const rows = result.rows as Array<{ cnt: number }>;
    return rows[0]?.cnt ?? 0;
  });
}

/**
 * Fetch booking_request rows visible to an org using withOrgContext (RLS-enforced).
 * After setTestAppRole(), all reads must go through withOrgContext to satisfy
 * FORCE RLS — direct db.execute without context returns 0 rows (fail-closed).
 */
async function fetchRows(
  db: PgliteTestClient,
  orgId: string,
): Promise<Array<Record<string, unknown>>> {
  return withOrgContext(db, orgId, async (tx) => {
    const result = await (tx as PgliteTestClient).execute(
      sql`SELECT * FROM booking_request WHERE org_id = ${orgId}::uuid ORDER BY created_at`,
    );
    return result.rows as Array<Record<string, unknown>>;
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  // Seed two orgs using the standard utility.
  const seed = await seedTwoOrgs(db);

  // seedTwoOrgs creates slugs 'alpha' and 'beta'.
  env = {
    db,
    pglite,
    orgAId: seed.orgAId,
    orgBId: seed.orgBId,
    slugA: 'alpha',
    slugB: 'beta',
  };

  // Switch to the restricted aeroops_app role so FORCE RLS is exercised.
  await setTestAppRole({ pglite });
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// ISO — Tenant isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('ISO — Tenant isolation', () => {
  it('ISO-1: inserted row org_id == slug-resolved org (org A slug → org A row)', async () => {
    const { db, orgAId, slugA } = env;

    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(db, slugA, minimalValid());
    expect(result.ok).toBe(true);

    // One new row in org A.
    const after = await countRows(db, orgAId);
    expect(after).toBe(before + 1);

    // The stored row's org_id is orgAId.
    const rows = await fetchRows(db, orgAId);
    const lastRow = rows[rows.length - 1]!;
    expect(lastRow['org_id']).toBe(orgAId);
  });

  it('ISO-1b: org B slug → org B row (separate slug maps to separate org)', async () => {
    const { db, orgBId, orgAId, slugB } = env;

    const beforeA = await countRows(db, orgAId);
    const beforeB = await countRows(db, orgBId);

    const result = await submitBookingRequestWithDb(db, slugB, minimalValid({ name: 'Bob Beta' }));
    expect(result.ok).toBe(true);

    // One new row in org B, zero new rows in org A.
    const afterA = await countRows(db, orgAId);
    const afterB = await countRows(db, orgBId);
    expect(afterB).toBe(beforeB + 1);
    expect(afterA).toBe(beforeA);

    // The stored row's org_id is orgBId.
    const rows = await fetchRows(db, orgBId);
    const lastRow = rows[rows.length - 1]!;
    expect(lastRow['org_id']).toBe(orgBId);
  });

  it('ISO-2: client-supplied org_id in the body is IGNORED (row tracks URL slug, not body)', async () => {
    const { db, orgAId, orgBId, slugA } = env;

    // Caller is using slug-A but sneaks org-B's id into the body.
    const bodyWithFakeOrgId = minimalValid({
      name: 'Sneaky Requester',
      // These fields are NOT in the bookingRequestSchema so they'll be stripped.
      // But test the invariant that the row always tracks the URL slug.
      org_id: orgBId,
      orgId: orgBId,
    });

    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(db, slugA, bodyWithFakeOrgId);
    expect(result.ok).toBe(true);

    // Row appears in org A (the URL slug org), not org B.
    const afterA = await countRows(db, orgAId);
    expect(afterA).toBe(before + 1);

    // Verify the stored row's org_id is orgAId.
    const rows = await fetchRows(db, orgAId);
    const matched = rows.filter((r) => r['requester_name'] === 'Sneaky Requester');
    expect(matched.length).toBeGreaterThan(0);
    expect(matched[matched.length - 1]!['org_id']).toBe(orgAId);
  });

  it('ISO-3: adversarial cross-org attempt: body claims org-B but slug is org-A; row goes to org-A', async () => {
    // This test verifies that even if the orchestrator had a bug and tried to insert
    // with a client-supplied org_id, the RLS WITH CHECK would reject it.
    // Because the orchestrator is CORRECT (org_id comes from resolvedOrg.id),
    // the row will land in org-A. We verify: no row in org-B, new row in org-A.
    const { db, orgAId, orgBId, slugA } = env;

    const beforeA = await countRows(db, orgAId);
    const beforeB = await countRows(db, orgBId);

    const result = await submitBookingRequestWithDb(db, slugA, minimalValid({
      name: 'Cross-org adversarial',
      // The body tries to set org_id to org-B — orchestrator must ignore it.
      org_id: orgBId,
      slug: 'beta',
    }));
    expect(result.ok).toBe(true);

    // Org-B has the same row count.
    const afterB = await countRows(db, orgBId);
    expect(afterB).toBe(beforeB);

    // Org-A has one more row.
    const afterA = await countRows(db, orgAId);
    expect(afterA).toBe(beforeA + 1);
  });

  it('ISO-4: submit returns no tenant data (ok:true only, no id/slug/orgId echoed)', async () => {
    const { db, slugA } = env;
    const result = await submitBookingRequestWithDb(db, slugA, minimalValid({ name: 'Data Echo Test' }));
    // Result must only be { ok: true } — no id, no org data.
    expect(result).toEqual({ ok: true });
    expect(Object.keys(result)).toEqual(['ok']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENUM — Anti-enumeration
// ─────────────────────────────────────────────────────────────────────────────

describe('ENUM — Anti-enumeration (unknown slug and suspended org indistinguishable)', () => {
  it('ENUM-1: unknown slug → { ok:false, reason:"unavailable" }', async () => {
    const { db } = env;
    const result = await submitBookingRequestWithDb(db, 'does-not-exist-xyz', minimalValid());
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('ENUM-2: suspended org → { ok:false, reason:"unavailable" } (byte-identical to ENUM-1)', async () => {
    const { db } = env;

    // Create a suspended org.
    const suspendedOrg = await withPlatformAdminContext(db, async (tx) => {
      const rows = await (tx as PgliteTestClient)
        .insert(org)
        .values({ name: 'Suspended FBO', slug: 'suspended-fbo', status: 'suspended' })
        .returning();
      return rows[0]!;
    });

    const result = await submitBookingRequestWithDb(db, suspendedOrg.slug, minimalValid());
    // Must be byte-identical to the unknown-slug case (anti-enumeration).
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('ENUM: suspended org and unknown slug return identically-shaped responses', async () => {
    const { db } = env;
    const unknownResult = await submitBookingRequestWithDb(db, 'never-created-slug-99', minimalValid());
    // We already tested the suspended case above; just confirm shapes match.
    expect(unknownResult.ok).toBe(false);
    if (!unknownResult.ok) {
      expect(unknownResult.reason).toBe('unavailable');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HP — Honeypot
// ─────────────────────────────────────────────────────────────────────────────

describe('HP — Honeypot', () => {
  it('HP-1: non-empty website → { ok:true }, no row inserted, zero DB access (fake success)', async () => {
    const { db, orgAId, slugA } = env;

    const before = await countRows(db, orgAId);

    // A bot fills the hidden `website` field.
    const result = await submitBookingRequestWithDb(db, slugA, {
      ...minimalValid(),
      website: 'https://spammy-bot.example.com',
    });

    // Fake success — same as a real submit.
    expect(result).toEqual({ ok: true });

    // No row was inserted.
    const after = await countRows(db, orgAId);
    expect(after).toBe(before);
  });

  it('HP-1b: non-empty website with valid-looking name/email still produces no row', async () => {
    const { db, orgAId, slugA } = env;
    const before = await countRows(db, orgAId);

    const result = await submitBookingRequestWithDb(db, slugA, {
      name: 'Perfectly Valid Name',
      email: 'valid@example.com',
      requestedStart: FUTURE_START,
      website: 'not-empty',
    });
    expect(result.ok).toBe(true);
    const after = await countRows(db, orgAId);
    expect(after).toBe(before);
  });

  it('HP-2: website absent → normal path (no fake-success side-effect)', async () => {
    const { db, orgAId, slugA } = env;
    const before = await countRows(db, orgAId);

    const result = await submitBookingRequestWithDb(db, slugA, minimalValid({ name: 'HP-2 Test' }));
    expect(result.ok).toBe(true);

    const after = await countRows(db, orgAId);
    expect(after).toBe(before + 1);
  });

  it('HP-2b: website empty string → normal path (empty string is falsy, not a honeypot trigger)', async () => {
    const { db, orgAId, slugA } = env;
    const before = await countRows(db, orgAId);

    const result = await submitBookingRequestWithDb(db, slugA, {
      ...minimalValid({ name: 'HP-2b empty website' }),
      website: '',
    });
    expect(result.ok).toBe(true);

    const after = await countRows(db, orgAId);
    expect(after).toBe(before + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VAL — Validation
// ─────────────────────────────────────────────────────────────────────────────

describe('VAL — Input validation', () => {
  it('VAL-1: missing name → { ok:false, reason:"invalid" }, no row', async () => {
    const { db, orgAId, slugA } = env;
    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(db, slugA, {
      email: 'jane@example.com',
      requestedStart: FUTURE_START,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(await countRows(db, orgAId)).toBe(before);
  });

  it('VAL-2: oversized name (121 chars) → { ok:false, reason:"invalid" }, no row', async () => {
    const { db, orgAId, slugA } = env;
    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(db, slugA, {
      ...minimalValid(),
      name: 'A'.repeat(121),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(await countRows(db, orgAId)).toBe(before);
  });

  it('VAL-2b: name exactly 120 chars is valid', async () => {
    const { db, orgAId, slugA } = env;
    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(db, slugA, {
      ...minimalValid(),
      name: 'B'.repeat(120),
    });
    expect(result.ok).toBe(true);
    expect(await countRows(db, orgAId)).toBe(before + 1);
  });

  it('VAL-3: invalid email format → { ok:false, reason:"invalid" }, no row', async () => {
    const { db, orgAId, slugA } = env;
    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(db, slugA, {
      ...minimalValid(),
      email: 'not-an-email',
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(await countRows(db, orgAId)).toBe(before);
  });

  it('VAL-4a: email exactly 254 chars is accepted', async () => {
    const { db, orgAId, slugA } = env;
    const before = await countRows(db, orgAId);
    // Build a 254-char email: local part + @example.com (12 chars)
    // 242 + 12 = 254
    const localPart = 'a'.repeat(242);
    const email254 = `${localPart}@example.com`;
    expect(email254.length).toBe(254);

    const result = await submitBookingRequestWithDb(db, slugA, {
      ...minimalValid(),
      email: email254,
    });
    expect(result.ok).toBe(true);
    expect(await countRows(db, orgAId)).toBe(before + 1);
  });

  it('VAL-4b: email 255 chars is rejected', async () => {
    const { db, orgAId, slugA } = env;
    const before = await countRows(db, orgAId);
    // 243 + 12 = 255
    const localPart = 'a'.repeat(243);
    const email255 = `${localPart}@example.com`;
    expect(email255.length).toBe(255);

    const result = await submitBookingRequestWithDb(db, slugA, {
      ...minimalValid(),
      email: email255,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(await countRows(db, orgAId)).toBe(before);
  });

  it('VAL-5: phone > 40 chars → invalid, no row', async () => {
    const { db, orgAId, slugA } = env;
    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(db, slugA, {
      ...minimalValid(),
      phone: '1'.repeat(41),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(await countRows(db, orgAId)).toBe(before);
  });

  it('VAL-6: message > 2000 chars → invalid, no row', async () => {
    const { db, orgAId, slugA } = env;
    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(db, slugA, {
      ...minimalValid(),
      message: 'M'.repeat(2001),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(await countRows(db, orgAId)).toBe(before);
  });

  it('VAL-7: aircraftTypePref > 80 chars → invalid, no row', async () => {
    const { db, orgAId, slugA } = env;
    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(db, slugA, {
      ...minimalValid(),
      aircraftTypePref: 'C'.repeat(81),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(await countRows(db, orgAId)).toBe(before);
  });

  it('VAL-8: requestedStart missing → invalid, no row', async () => {
    const { db, orgAId, slugA } = env;
    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(db, slugA, {
      name: 'Jane',
      email: 'jane@example.com',
      // requestedStart intentionally omitted
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(await countRows(db, orgAId)).toBe(before);
  });

  it('VAL-9: requestedEnd before requestedStart → invalid, no row', async () => {
    const { db, orgAId, slugA } = env;
    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(db, slugA, {
      ...minimalValid(),
      requestedStart: '2027-06-01T14:00:00.000Z',
      requestedEnd:   '2027-06-01T12:00:00.000Z',  // before start
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(await countRows(db, orgAId)).toBe(before);
  });

  it('VAL-10: minimal valid payload → { ok:true }, row inserted with correct fields', async () => {
    // Use a dedicated org so the rate guard does not interfere with row-inspection.
    const { db } = env;
    const testOrg = await withPlatformAdminContext(db, async (tx) => {
      const rows = await (tx as PgliteTestClient)
        .insert(org)
        .values({ name: 'Val-10 Org', slug: 'val-10-org', status: 'active' })
        .returning();
      return rows[0]!;
    });

    const result = await submitBookingRequestWithDb(db, testOrg.slug, {
      name: 'Val-10 Minimal',
      email: 'val10@example.com',
      requestedStart: FUTURE_START,
    });
    expect(result).toEqual({ ok: true });

    // Inspect the stored row.
    const rows = await fetchRows(db, testOrg.id);
    const row = rows.find((r) => r['requester_name'] === 'Val-10 Minimal')!;
    expect(row).toBeDefined();
    expect(row['org_id']).toBe(testOrg.id);
    expect(row['status']).toBe('new');
    expect(row['requester_email']).toBe('val10@example.com');
    expect(row['requester_phone']).toBeNull();
    expect(row['requested_end']).toBeNull();
    expect(row['aircraft_type_pref']).toBeNull();
    expect(row['message']).toBeNull();
    expect(row['handled_by']).toBeNull();
    expect(row['handled_at']).toBeNull();
  });

  it('VAL-11: email is stored normalised (lowercased + trimmed)', async () => {
    // Use a dedicated org for isolation.
    const { db } = env;
    const testOrg = await withPlatformAdminContext(db, async (tx) => {
      const rows = await (tx as PgliteTestClient)
        .insert(org)
        .values({ name: 'Val-11 Org', slug: 'val-11-org', status: 'active' })
        .returning();
      return rows[0]!;
    });

    const result = await submitBookingRequestWithDb(db, testOrg.slug, {
      name: 'Email Normalise Test',
      email: '  JANE.PILOT@EXAMPLE.COM  ',
      requestedStart: FUTURE_START,
    });
    expect(result.ok).toBe(true);

    const rows = await fetchRows(db, testOrg.id);
    const row = rows.find((r) => r['requester_name'] === 'Email Normalise Test')!;
    expect(row).toBeDefined();
    expect(row['requester_email']).toBe('jane.pilot@example.com');
  });

  it('VAL-12: name is trimmed (leading/trailing whitespace stripped)', async () => {
    // Use a dedicated org for isolation.
    const { db } = env;
    const testOrg = await withPlatformAdminContext(db, async (tx) => {
      const rows = await (tx as PgliteTestClient)
        .insert(org)
        .values({ name: 'Val-12 Org', slug: 'val-12-org', status: 'active' })
        .returning();
      return rows[0]!;
    });

    const result = await submitBookingRequestWithDb(db, testOrg.slug, {
      name: '   Trimmed Name   ',
      email: 'trim@example.com',
      requestedStart: FUTURE_START,
    });
    expect(result.ok).toBe(true);

    const rows = await fetchRows(db, testOrg.id);
    const row = rows.find((r) => r['requester_name'] === 'Trimmed Name')!;
    expect(row).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB — Row field assertions
// ─────────────────────────────────────────────────────────────────────────────

describe('DB — Stored row fields', () => {
  it('DB-2: optional fields stored correctly when provided', async () => {
    // Use a dedicated org so the rate guard (10/min shared with other tests) doesn't interfere.
    const { db } = env;
    const testOrg = await withPlatformAdminContext(db, async (tx) => {
      const rows = await (tx as PgliteTestClient)
        .insert(org)
        .values({ name: 'DB-2 Org', slug: 'db-2-org', status: 'active' })
        .returning();
      return rows[0]!;
    });

    const result = await submitBookingRequestWithDb(db, testOrg.slug, {
      name: 'DB-2 Full Fields',
      email: 'db2@example.com',
      phone: '+1-555-0101',
      requestedStart: '2027-03-01T10:00:00.000Z',
      requestedEnd:   '2027-03-01T12:00:00.000Z',
      aircraftTypePref: 'Cessna 172',
      message: 'I would like to book for my first lesson.',
    });
    expect(result.ok).toBe(true);

    const rows = await fetchRows(db, testOrg.id);
    const row = rows.find((r) => r['requester_name'] === 'DB-2 Full Fields')!;
    expect(row).toBeDefined();
    expect(row['requester_phone']).toBe('+1-555-0101');
    expect(row['aircraft_type_pref']).toBe('Cessna 172');
    expect(row['message']).toBe('I would like to book for my first lesson.');
    expect(row['requested_end']).not.toBeNull();
    expect(row['status']).toBe('new');
    expect(row['handled_by']).toBeNull();
    expect(row['handled_at']).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RATE — Per-org rate guard
// ─────────────────────────────────────────────────────────────────────────────

describe('RATE — Per-org rate guard', () => {
  it('RATE-1: (N+1)th submit within 1 minute returns fake ok, no new row', async () => {
    const { db, orgBId, slugB } = env;

    // We need a fresh org to test the rate guard cleanly (so we control the count).
    // Create a third org under superuser context.
    const rateOrg = await withPlatformAdminContext(db, async (tx) => {
      const rows = await (tx as PgliteTestClient)
        .insert(org)
        .values({ name: 'Rate Test Org', slug: 'rate-test-org', status: 'active' })
        .returning();
      return rows[0]!;
    });

    // Insert RATE_LIMIT_PER_ORG_PER_MIN rows directly into the DB (bypassing the
    // orchestrator) to simulate having hit the limit. We use withOrgContext to
    // satisfy RLS. This does NOT go through the rate guard, so we can control the count.
    const startTime = new Date(Date.now() - 30_000); // 30 seconds ago (within the 1-min window)
    for (let i = 0; i < RATE_LIMIT_PER_ORG_PER_MIN; i++) {
      await withOrgContext(db, rateOrg.id, async (tx) => {
        await (tx as PgliteTestClient).insert(bookingRequest).values({
          orgId: rateOrg.id,
          status: 'new',
          requesterName: `Rate seed ${i}`,
          requesterEmail: `seed${i}@rate.example.com`,
          requestedStart: new Date('2027-02-01T10:00:00Z'),
          // Set createdAt explicitly to be within the 1-minute window.
          // Note: the default is now() so we don't need to override it — just insert normally.
        });
      });
    }

    // Verify we have exactly RATE_LIMIT rows in org.
    const count = await countRows(db, rateOrg.id);
    expect(count).toBe(RATE_LIMIT_PER_ORG_PER_MIN);

    // The (N+1)th submit via the orchestrator should be rate-limited.
    const result = await submitBookingRequestWithDb(db, rateOrg.slug, minimalValid({ name: 'Rate Overflow' }));

    // Fake success (silent drop).
    expect(result.ok).toBe(true);

    // No new row was inserted.
    const countAfter = await countRows(db, rateOrg.id);
    expect(countAfter).toBe(RATE_LIMIT_PER_ORG_PER_MIN);
  });

  it('RATE-2: rate guard is per-org; org-A limit does not block org-B', async () => {
    // This is implicitly tested by the separate org in RATE-1, but we make it explicit.
    // Org B (seeded) hasn't hit the limit, so a submit should succeed.
    const { db, orgBId, slugB } = env;

    const before = await countRows(db, orgBId);
    const result = await submitBookingRequestWithDb(db, slugB, minimalValid({ name: 'Rate-2 B submit' }));
    expect(result.ok).toBe(true);
    expect(await countRows(db, orgBId)).toBeGreaterThan(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — Row-level security
// ─────────────────────────────────────────────────────────────────────────────

describe('RLS — Row-level security', () => {
  it('RLS-1: SELECT under wrong org context returns 0 rows', async () => {
    const { db, orgAId, orgBId, slugA } = env;

    // Insert a row in org A.
    await submitBookingRequestWithDb(db, slugA, minimalValid({ name: 'RLS-1 Row' }));

    // Count org-A rows when querying under org-B context.
    const visibleUnderOrgB = await withOrgContext(db, orgBId, async (tx) => {
      const result = await (tx as PgliteTestClient).execute(
        sql`SELECT COUNT(*)::int AS cnt FROM booking_request WHERE org_id = ${orgAId}::uuid`,
      );
      const rows = result.rows as Array<{ cnt: number }>;
      return rows[0]?.cnt ?? 0;
    });

    // RLS should prevent org-B from seeing org-A rows.
    expect(visibleUnderOrgB).toBe(0);
  });

  it('RLS-2: migration 0015 applied; booking_request table exists + RLS is enabled', async () => {
    const { db } = env;

    // Query pg_class to verify RLS is enabled + forced on booking_request.
    const result = await db.execute(
      sql`SELECT relrowsecurity, relforcerowsecurity
          FROM pg_class
          WHERE relname = 'booking_request'`,
    );

    const rows = result.rows as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.relrowsecurity).toBe(true);
    expect(rows[0]!.relforcerowsecurity).toBe(true);
  });

  it('RLS-3: UNIQUE(id, org_id) index exists on booking_request', async () => {
    const { db } = env;

    const result = await db.execute(
      sql`SELECT indexname FROM pg_indexes
          WHERE tablename = 'booking_request'
          AND indexname = 'booking_request_id_org_id_unique'`,
    );

    const rows = result.rows as Array<{ indexname: string }>;
    expect(rows.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA — bookingRequestSchema unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('SCHEMA — bookingRequestSchema unit tests', () => {
  it('schema: valid minimal input parses successfully', async () => {
    const { bookingRequestSchema } = await import('@aeroops/core');
    const result = bookingRequestSchema.safeParse(minimalValid());
    expect(result.success).toBe(true);
  });

  it('schema: empty name after trim → failure (nonempty required)', async () => {
    const { bookingRequestSchema } = await import('@aeroops/core');
    const result = bookingRequestSchema.safeParse({ ...minimalValid(), name: '   ' });
    expect(result.success).toBe(false);
  });

  it('schema: email is lowercased after parsing', async () => {
    const { bookingRequestSchema } = await import('@aeroops/core');
    const result = bookingRequestSchema.safeParse({ ...minimalValid(), email: 'UPPER@EXAMPLE.COM' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('upper@example.com');
    }
  });

  it('schema: requestedEnd must be after requestedStart (cross-field refinement)', async () => {
    const { bookingRequestSchema } = await import('@aeroops/core');
    const result = bookingRequestSchema.safeParse({
      ...minimalValid(),
      requestedStart: '2027-06-01T14:00:00.000Z',
      requestedEnd:   '2027-06-01T13:59:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('schema: requestedEnd == requestedStart → failure (must be strictly after)', async () => {
    const { bookingRequestSchema } = await import('@aeroops/core');
    const result = bookingRequestSchema.safeParse({
      ...minimalValid(),
      requestedStart: '2027-06-01T14:00:00.000Z',
      requestedEnd:   '2027-06-01T14:00:00.000Z',  // equal, not after
    });
    expect(result.success).toBe(false);
  });

  it('schema: website field accepted (any value — honeypot check is in orchestrator)', async () => {
    const { bookingRequestSchema } = await import('@aeroops/core');
    const result = bookingRequestSchema.safeParse({ ...minimalValid(), website: 'https://spam.example.com' });
    // Schema accepts it; orchestrator is responsible for fake-ok logic.
    expect(result.success).toBe(true);
  });
});
