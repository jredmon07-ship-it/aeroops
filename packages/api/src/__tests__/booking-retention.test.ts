/**
 * booking-retention.test.ts — Slice PB-LR.A retention config + purge integration tests.
 * pglite + *WithDb forms; migrations 0000–0017; two seeded orgs.
 *
 * COVERAGE:
 *
 * CAP — Capability enforcement:
 *   CAP-1  owner/manager → setBookingRetention passes.
 *   CAP-2  dispatcher (booking:triage-only) → ForbiddenError (setter).
 *   CAP-3  null session → UnauthenticatedError (setter).
 *   CAP-4  owner/manager → getBookingRetention passes.
 *   CAP-5  dispatcher/cfi/mechanic/renter/student/accountant → ForbiddenError (getter).
 *   CAP-6  owner/manager → purgeExpiredBookingRequests passes (dry-run).
 *   CAP-7  dispatcher → ForbiddenError (purge).
 *   CAP-8  null session → UnauthenticatedError (purge).
 *
 * SETTER — setBookingRetention upsert + audit:
 *   SETTER-1  create (no prior row) → { ok:true, retentionDays, includesConverted }.
 *   SETTER-2  update (existing row) → new values persisted.
 *   SETTER-3  audit row written on create.
 *   SETTER-4  audit row has prev+new snapshot on update (no PII).
 *   SETTER-5  range reject: retentionDays = -1 → ValidationError.
 *   SETTER-6  range reject: retentionDays = 3651 → ValidationError.
 *   SETTER-7  range accept: retentionDays = 0 → stored correctly.
 *   SETTER-8  range accept: retentionDays = 3650 → stored correctly.
 *
 * GETTER — getBookingRetention defaults + saved:
 *   GETTER-1  absent row → defaults { retentionDays: 365, includesConverted: false }.
 *   GETTER-2  after set → reflects saved values.
 *
 * PURGE — purgeExpiredBookingRequests happy path + safety guards:
 *   PURGE-1  happy: dryRun=true counts rows, no delete, no audit row.
 *   PURGE-2  happy: dryRun=false deletes expired rows, writes audit row.
 *   PURGE-3  audit metadata contains only counts (no requester PII — name/email absent).
 *   PURGE-4  days=0 no-op: retentionDisabled=true, nothing deleted (the footgun guard).
 *   PURGE-5  boundary: row exactly AT cutoff survives (strict < cutoff, not <=).
 *   PURGE-6  converted excluded by default (status='converted' not deleted).
 *   PURGE-7  converted included when flag=true (status='converted' deleted with others).
 *   PURGE-8  linked reservation survives when booking_request is purged (no cascade up).
 *   PURGE-9  idempotency: 2nd apply run deletes 0 rows.
 *   PURGE-10 eligible statuses ('new','contacted','declined') deleted; 'converted' not (default).
 *
 * T-ISO — Tenant isolation (RLS):
 *   T-ISO-1  org A purge deletes ONLY org A rows; org B rows untouched.
 *   T-ISO-2  getter for org A returns org A config (not org B config).
 *
 * PROP — Property test:
 *   PROP-1  deleted set == exactly { created_at < cutoff AND status IN eligible }
 *            AND never another org's rows (fast-check, 20 runs).
 *
 * SCHEMA-0017 — DB schema for migration 0017:
 *   SCHEMA-1  booking_request_retention_days column exists on dispatch_config.
 *   SCHEMA-2  booking_request_retention_includes_converted column exists.
 *   SCHEMA-3  CHECK rejects retentionDays = -1.
 *   SCHEMA-4  CHECK rejects retentionDays = 3651.
 *   SCHEMA-5  CHECK accepts retentionDays = 0.
 *   SCHEMA-6  CHECK accepts retentionDays = 3650.
 *   SCHEMA-7  Down migration removes both columns + constraint.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import * as fc from 'fast-check';
import { sql, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  withPlatformAdminContext,
  seedTwoOrgs,
} from '@aeroops/db';
import { auditLog, bookingRequest } from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import type { MembershipRole } from '@aeroops/core';

import {
  getBookingRetentionWithDb,
  setBookingRetentionWithDb,
  purgeExpiredBookingRequestsWithDb,
  UnauthenticatedError,
  ForbiddenError,
} from '../index.js';

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
  readFileSync(resolve(__dirname, '../../../db/migrations/0017_booking_retention.sql'),       'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0018_dispatch_ticket_correction.sql'),       'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0019_billing_records.sql'),       'utf-8'),
];

const DOWN_0017 = readFileSync(
  resolve(__dirname, '../../../db/migrations/0017_booking_retention.down.sql'),
  'utf-8',
);

// ── Shared test environment ───────────────────────────────────────────────────

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
}

let env: TestEnv;

// ── Session factory ───────────────────────────────────────────────────────────

function makeSession(role: MembershipRole, orgId: string, userId: string) {
  return {
    userId,
    orgId,
    slug: 'test-org',
    role,
    user: { email: 'staff@test.example' },
  };
}

// ── Booking request insert helper ─────────────────────────────────────────────

/**
 * Insert a booking_request row directly at a given created_at timestamp.
 * Handles handled_at automatically for statuses that require it (contacted/declined/converted).
 * Must be called within withOrgContext or as superuser.
 */
async function insertBookingRequestAt(
  db: PgliteTestClient,
  orgId: string,
  opts: {
    status?: string;
    createdAt?: string; // ISO timestamp
    requesterName?: string;
    requesterEmail?: string;
  } = {},
): Promise<string> {
  return withOrgContext(db, orgId, async (tx) => {
    const createdAt = opts.createdAt ?? '2020-01-01T00:00:00Z';
    const status = opts.status ?? 'new';
    // handled_at is required for all non-'new' statuses (shape check).
    const handledAt = status !== 'new' ? createdAt : null;
    const result = await (tx as PgliteTestClient).execute(sql`
      INSERT INTO booking_request (
        org_id, status, requester_name, requester_email,
        requested_start, created_at, updated_at, handled_at
      ) VALUES (
        ${orgId}::uuid,
        ${status},
        ${opts.requesterName ?? 'Test Requester'},
        ${opts.requesterEmail ?? 'requester@test.example'},
        '2027-06-01T10:00:00Z'::timestamptz,
        ${createdAt}::timestamptz,
        ${createdAt}::timestamptz,
        ${handledAt}::timestamptz
      )
      RETURNING id
    `);
    const rows = result.rows as Array<{ id: string }>;
    return rows[0]!.id;
  });
}

/**
 * Count audit_log rows for a given action within an org.
 */
async function countAuditByAction(
  db: PgliteTestClient,
  orgId: string,
  action: string,
): Promise<number> {
  return withOrgContext(db, orgId, async (tx) => {
    const result = await (tx as PgliteTestClient).execute(sql`
      SELECT COUNT(*)::int AS cnt
      FROM audit_log
      WHERE org_id = ${orgId}::uuid
        AND action = ${action}
    `);
    const rows = result.rows as Array<{ cnt: number }>;
    return rows[0]?.cnt ?? 0;
  });
}

/**
 * Fetch all audit_log rows for a given action and org (newest first).
 */
async function fetchAuditRows(
  db: PgliteTestClient,
  orgId: string,
  action: string,
): Promise<Array<Record<string, unknown>>> {
  return withOrgContext(db, orgId, async (tx) => {
    const result = await (tx as PgliteTestClient).execute(sql`
      SELECT * FROM audit_log
      WHERE org_id = ${orgId}::uuid
        AND action = ${action}
      ORDER BY created_at DESC
    `);
    return result.rows as Array<Record<string, unknown>>;
  });
}

/**
 * Count booking_request rows for an org.
 */
async function countBookingRequests(
  db: PgliteTestClient,
  orgId: string,
): Promise<number> {
  return withOrgContext(db, orgId, async (tx) => {
    const result = await (tx as PgliteTestClient).execute(sql`
      SELECT COUNT(*)::int AS cnt FROM booking_request WHERE org_id = ${orgId}::uuid
    `);
    const rows = result.rows as Array<{ cnt: number }>;
    return rows[0]?.cnt ?? 0;
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const seed = await seedTwoOrgs(db);

  env = {
    db,
    pglite,
    orgAId: seed.orgAId,
    orgBId: seed.orgBId,
    userAId: seed.userAId,
    userBId: seed.userBId,
  };

  // Switch to restricted aeroops_app role so FORCE RLS is active.
  await setTestAppRole({ pglite });
}, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
// CAP — Capability enforcement
// ═════════════════════════════════════════════════════════════════════════════

describe('CAP — Capability enforcement', () => {
  it('CAP-1: owner/manager → setBookingRetention passes', async () => {
    const { db, orgAId, userAId } = env;
    for (const role of ['owner', 'manager'] as const) {
      const session = makeSession(role, orgAId, userAId);
      const result = await setBookingRetentionWithDb(db, session, {
        retentionDays: 365,
        includesConverted: false,
      });
      expect(result.ok).toBe(true);
    }
  });

  it('CAP-2: dispatcher (booking:triage-only) → ForbiddenError on setBookingRetention', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('dispatcher', orgAId, userAId);
    await expect(
      setBookingRetentionWithDb(db, session, { retentionDays: 365, includesConverted: false }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('CAP-3: null session → UnauthenticatedError on setBookingRetention', async () => {
    const { db } = env;
    await expect(
      setBookingRetentionWithDb(db, null, { retentionDays: 365, includesConverted: false }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('CAP-4: owner/manager → getBookingRetention passes', async () => {
    const { db, orgAId, userAId } = env;
    for (const role of ['owner', 'manager'] as const) {
      const session = makeSession(role, orgAId, userAId);
      const result = await getBookingRetentionWithDb(db, session);
      expect(result).toHaveProperty('retentionDays');
      expect(result).toHaveProperty('includesConverted');
    }
  });

  it('CAP-5: dispatcher/cfi/mechanic/renter/student/accountant → ForbiddenError on getBookingRetention', async () => {
    const { db, orgAId, userAId } = env;
    const forbiddenRoles: MembershipRole[] = ['dispatcher', 'cfi', 'mechanic', 'renter', 'student', 'accountant'];
    for (const role of forbiddenRoles) {
      const session = makeSession(role, orgAId, userAId);
      await expect(
        getBookingRetentionWithDb(db, session),
      ).rejects.toThrow(ForbiddenError);
    }
  });

  it('CAP-6: owner/manager → purgeExpiredBookingRequests passes (dry-run)', async () => {
    const { db, orgAId, userAId } = env;
    for (const role of ['owner', 'manager'] as const) {
      const session = makeSession(role, orgAId, userAId);
      const result = await purgeExpiredBookingRequestsWithDb(db, session, { dryRun: true });
      expect(result.ok).toBe(true);
    }
  });

  it('CAP-7: dispatcher → ForbiddenError on purgeExpiredBookingRequests', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('dispatcher', orgAId, userAId);
    await expect(
      purgeExpiredBookingRequestsWithDb(db, session, { dryRun: true }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('CAP-8: null session → UnauthenticatedError on purgeExpiredBookingRequests', async () => {
    const { db } = env;
    await expect(
      purgeExpiredBookingRequestsWithDb(db, null, { dryRun: true }),
    ).rejects.toThrow(UnauthenticatedError);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SETTER — setBookingRetention upsert + audit
// ═════════════════════════════════════════════════════════════════════════════

describe('SETTER — setBookingRetention upsert + audit', () => {
  it('SETTER-1: create (no prior row) → { ok:true, retentionDays, includesConverted }', async () => {
    // Use org B to avoid collision with other tests using org A.
    const { db, orgBId, userBId } = env;
    const session = makeSession('owner', orgBId, userBId);
    const result = await setBookingRetentionWithDb(db, session, {
      retentionDays: 180,
      includesConverted: true,
    });
    expect(result).toEqual({ ok: true, retentionDays: 180, includesConverted: true });
  });

  it('SETTER-2: update (existing row) → new values persisted', async () => {
    const { db, orgBId, userBId } = env;
    const session = makeSession('owner', orgBId, userBId);

    await setBookingRetentionWithDb(db, session, {
      retentionDays: 90,
      includesConverted: false,
    });

    const got = await getBookingRetentionWithDb(db, session);
    expect(got.retentionDays).toBe(90);
    expect(got.includesConverted).toBe(false);
  });

  it('SETTER-3: audit row written on create', async () => {
    const { db, orgBId, userBId } = env;
    const session = makeSession('owner', orgBId, userBId);
    const beforeCount = await countAuditByAction(db, orgBId, 'booking_retention.config_changed');

    await setBookingRetentionWithDb(db, session, {
      retentionDays: 500,
      includesConverted: false,
    });

    const afterCount = await countAuditByAction(db, orgBId, 'booking_retention.config_changed');
    expect(afterCount).toBe(beforeCount + 1);
  });

  it('SETTER-4: audit row has prev+new snapshot on update (no PII)', async () => {
    const { db, orgBId, userBId } = env;
    const session = makeSession('owner', orgBId, userBId);

    // Set known previous state.
    await setBookingRetentionWithDb(db, session, {
      retentionDays: 100,
      includesConverted: false,
    });

    // Update to new state.
    await setBookingRetentionWithDb(db, session, {
      retentionDays: 200,
      includesConverted: true,
    });

    const auditRows = await fetchAuditRows(db, orgBId, 'booking_retention.config_changed');
    const latest = auditRows[0];
    expect(latest).toBeDefined();

    const meta = latest!.metadata as Record<string, unknown>;
    // New values must be present.
    expect(meta.retentionDays).toBe(200);
    expect(meta.includesConverted).toBe(true);
    // Previous values must be present.
    expect(meta.previousRetentionDays).toBe(100);
    expect(meta.previousIncludesConverted).toBe(false);
    // Must NOT contain requester PII.
    expect(JSON.stringify(meta)).not.toContain('requester');
    expect(JSON.stringify(meta)).not.toContain('email');
    expect(JSON.stringify(meta)).not.toContain('name');
    expect(JSON.stringify(meta)).not.toContain('phone');
  });

  it('SETTER-5: range reject: retentionDays = -1 → ValidationError', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);
    await expect(
      setBookingRetentionWithDb(db, session, { retentionDays: -1, includesConverted: false }),
    ).rejects.toThrow();
  });

  it('SETTER-6: range reject: retentionDays = 3651 → ValidationError', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);
    await expect(
      setBookingRetentionWithDb(db, session, { retentionDays: 3651, includesConverted: false }),
    ).rejects.toThrow();
  });

  it('SETTER-7: range accept: retentionDays = 0 → stored correctly', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);
    const result = await setBookingRetentionWithDb(db, session, {
      retentionDays: 0,
      includesConverted: false,
    });
    expect(result.ok).toBe(true);
    expect(result.retentionDays).toBe(0);
    const got = await getBookingRetentionWithDb(db, session);
    expect(got.retentionDays).toBe(0);
  });

  it('SETTER-8: range accept: retentionDays = 3650 → stored correctly', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);
    const result = await setBookingRetentionWithDb(db, session, {
      retentionDays: 3650,
      includesConverted: false,
    });
    expect(result.ok).toBe(true);
    expect(result.retentionDays).toBe(3650);
    const got = await getBookingRetentionWithDb(db, session);
    expect(got.retentionDays).toBe(3650);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GETTER — getBookingRetention defaults + saved
// ═════════════════════════════════════════════════════════════════════════════

describe('GETTER — getBookingRetention defaults + saved', () => {
  it('GETTER-1: absent row for fresh org → defaults { retentionDays: 365, includesConverted: false }', async () => {
    // Spin up an isolated client with a third org that has no dispatch_config.
    const { pglite: pg2, db: db2 } = await createTestClient();
    await applyMigrationSql({ pglite: pg2 }, MIGRATION_SQL);

    let freshOrgId: string;
    let freshUserId: string;
    await withPlatformAdminContext(db2, async (tx) => {
      const orgRows = await (tx as PgliteTestClient).execute(sql`
        INSERT INTO org (name, slug) VALUES ('Fresh Org', 'fresh-org') RETURNING id
      `);
      freshOrgId = (orgRows.rows as Array<{ id: string }>)[0]!.id;
      const userRows = await (tx as PgliteTestClient).execute(sql`
        INSERT INTO app_user (org_id, email, full_name)
        VALUES (${freshOrgId}::uuid, 'fresh@example.com', 'Fresh User')
        RETURNING id
      `);
      freshUserId = (userRows.rows as Array<{ id: string }>)[0]!.id;
    });
    await setTestAppRole({ pglite: pg2 });

    const session = makeSession('owner', freshOrgId!, freshUserId!);
    const result = await getBookingRetentionWithDb(db2, session);
    expect(result.retentionDays).toBe(365);
    expect(result.includesConverted).toBe(false);
  }, 30_000);

  it('GETTER-2: after set → reflects saved values', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    await setBookingRetentionWithDb(db, session, {
      retentionDays: 730,
      includesConverted: true,
    });

    const got = await getBookingRetentionWithDb(db, session);
    expect(got.retentionDays).toBe(730);
    expect(got.includesConverted).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PURGE — purgeExpiredBookingRequests happy path + safety guards
// ═════════════════════════════════════════════════════════════════════════════

describe('PURGE — purgeExpiredBookingRequests happy path + safety guards', () => {
  /**
   * Helper: set retention days for orgA and insert expired + fresh rows.
   */
  async function setupPurgeScenario(
    db: PgliteTestClient,
    orgId: string,
    userId: string,
    opts: {
      retentionDays: number;
      includesConverted?: boolean;
      /** expiredStatuses to insert (with old timestamps) */
      expiredStatuses?: string[];
      /** freshStatuses to insert (with NOW) */
      freshStatuses?: string[];
    },
  ) {
    const session = makeSession('owner', orgId, userId);
    // Set config.
    await setBookingRetentionWithDb(db, session, {
      retentionDays: opts.retentionDays,
      includesConverted: opts.includesConverted ?? false,
    });

    const expiredIds: string[] = [];
    const freshIds: string[] = [];

    // Insert expired rows (created 10 days before the cutoff).
    for (const status of opts.expiredStatuses ?? ['new']) {
      // Use a date far in the past to ensure they're before the cutoff.
      const id = await insertBookingRequestAt(db, orgId, {
        status,
        createdAt: '2000-01-01T00:00:00Z',
      });
      expiredIds.push(id);
    }

    // Insert fresh rows (created now).
    for (const status of opts.freshStatuses ?? []) {
      const id = await insertBookingRequestAt(db, orgId, {
        status,
        // Use far future to ensure fresh
        createdAt: new Date(Date.now() + 86_400_000 * 365).toISOString(),
      });
      freshIds.push(id);
    }

    return { session, expiredIds, freshIds };
  }

  /**
   * Check whether a booking_request row still exists.
   */
  async function rowExists(
    db: PgliteTestClient,
    orgId: string,
    id: string,
  ): Promise<boolean> {
    return withOrgContext(db, orgId, async (tx) => {
      const result = await (tx as PgliteTestClient).execute(sql`
        SELECT 1 FROM booking_request WHERE id = ${id}::uuid
      `);
      return result.rows.length > 0;
    });
  }

  it('PURGE-1: dryRun=true counts eligible rows, no delete, no audit', async () => {
    // Use an isolated client for clean counts.
    const { pglite: pg3, db: db3 } = await createTestClient();
    await applyMigrationSql({ pglite: pg3 }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db3);
    await setTestAppRole({ pglite: pg3 });

    const { session, expiredIds } = await setupPurgeScenario(db3, seed.orgAId, seed.userAId, {
      retentionDays: 1, // 1-day retention; rows from 2000 are eligible
      expiredStatuses: ['new', 'contacted', 'declined'],
    });

    const auditBefore = await countAuditByAction(db3, seed.orgAId, 'booking_request.purged');
    const countBefore = await countBookingRequests(db3, seed.orgAId);

    const result = await purgeExpiredBookingRequestsWithDb(db3, session, { dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.eligibleCount).toBeGreaterThanOrEqual(expiredIds.length);
    expect(result.deletedCount).toBe(0);
    expect(result.retentionDisabled).toBe(false);

    // No rows deleted.
    const countAfter = await countBookingRequests(db3, seed.orgAId);
    expect(countAfter).toBe(countBefore);

    // No audit row written.
    const auditAfter = await countAuditByAction(db3, seed.orgAId, 'booking_request.purged');
    expect(auditAfter).toBe(auditBefore);
  }, 30_000);

  it('PURGE-2: dryRun=false deletes expired rows, writes one audit row', async () => {
    const { pglite: pg4, db: db4 } = await createTestClient();
    await applyMigrationSql({ pglite: pg4 }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db4);
    await setTestAppRole({ pglite: pg4 });

    const { session, expiredIds } = await setupPurgeScenario(db4, seed.orgAId, seed.userAId, {
      retentionDays: 1,
      expiredStatuses: ['new', 'new', 'declined'],
    });

    const auditBefore = await countAuditByAction(db4, seed.orgAId, 'booking_request.purged');

    const result = await purgeExpiredBookingRequestsWithDb(db4, session, { dryRun: false });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.deletedCount).toBeGreaterThanOrEqual(expiredIds.length);
    expect(result.retentionDisabled).toBe(false);

    // All expired rows must be gone.
    for (const id of expiredIds) {
      const exists = await rowExists(db4, seed.orgAId, id);
      expect(exists).toBe(false);
    }

    // Exactly one audit row written.
    const auditAfter = await countAuditByAction(db4, seed.orgAId, 'booking_request.purged');
    expect(auditAfter).toBe(auditBefore + 1);
  }, 30_000);

  it('PURGE-3: audit metadata contains only counts — no requester PII', async () => {
    const { pglite: pg5, db: db5 } = await createTestClient();
    await applyMigrationSql({ pglite: pg5 }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db5);
    await setTestAppRole({ pglite: pg5 });

    const { session } = await setupPurgeScenario(db5, seed.orgAId, seed.userAId, {
      retentionDays: 1,
      expiredStatuses: ['new'],
    });

    await purgeExpiredBookingRequestsWithDb(db5, session, { dryRun: false });

    const auditRows = await fetchAuditRows(db5, seed.orgAId, 'booking_request.purged');
    expect(auditRows.length).toBeGreaterThan(0);

    const meta = auditRows[0]!.metadata as Record<string, unknown>;
    const metaStr = JSON.stringify(meta);

    // Must contain counts.
    expect(typeof meta.deletedCount).toBe('number');
    expect(typeof meta.retentionDays).toBe('number');
    expect(typeof meta.includesConverted).toBe('boolean');
    expect(typeof meta.cutoffIso).toBe('string');

    // Must NOT contain requester PII.
    expect(metaStr).not.toContain('Requester');
    expect(metaStr).not.toContain('requester@');
    expect(metaStr).not.toContain('requester_name');
    expect(metaStr).not.toContain('requester_email');
    expect(metaStr).not.toContain('phone');
    expect(metaStr).not.toContain('message');
  }, 30_000);

  it('PURGE-4: days=0 no-op — retentionDisabled=true, nothing deleted (the footgun guard)', async () => {
    const { pglite: pg6, db: db6 } = await createTestClient();
    await applyMigrationSql({ pglite: pg6 }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db6);
    await setTestAppRole({ pglite: pg6 });

    const session = makeSession('owner', seed.orgAId, seed.userAId);
    // Set retention to 0 (keep-forever / retention disabled).
    await setBookingRetentionWithDb(db6, session, { retentionDays: 0, includesConverted: false });

    // Insert rows from far past.
    await insertBookingRequestAt(db6, seed.orgAId, {
      status: 'new',
      createdAt: '2000-01-01T00:00:00Z',
    });

    const countBefore = await countBookingRequests(db6, seed.orgAId);
    const auditBefore = await countAuditByAction(db6, seed.orgAId, 'booking_request.purged');

    const result = await purgeExpiredBookingRequestsWithDb(db6, session, { dryRun: false });

    expect(result.ok).toBe(true);
    expect(result.retentionDisabled).toBe(true);
    expect(result.eligibleCount).toBe(0);
    expect(result.deletedCount).toBe(0);

    // Rows still exist.
    const countAfter = await countBookingRequests(db6, seed.orgAId);
    expect(countAfter).toBe(countBefore);

    // No audit row.
    const auditAfter = await countAuditByAction(db6, seed.orgAId, 'booking_request.purged');
    expect(auditAfter).toBe(auditBefore);
  }, 30_000);

  it('PURGE-5: boundary — row created AFTER cutoff survives; row before cutoff deleted (strict <)', async () => {
    // Boundary semantics: eligible = created_at < (now() - make_interval(days=>retentionDays)).
    // So a row created at (now() - retentionDays + 1 hour) is NOT eligible and must survive.
    // A row created at '2000-01-01' is well before any cutoff and must be deleted.
    const { pglite: pg7, db: db7 } = await createTestClient();
    await applyMigrationSql({ pglite: pg7 }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db7);
    await setTestAppRole({ pglite: pg7 });

    const session = makeSession('owner', seed.orgAId, seed.userAId);
    // Use 30-day retention.
    await setBookingRetentionWithDb(db7, session, { retentionDays: 30, includesConverted: false });

    // Insert a row 1 hour BEFORE the cutoff (29 days + 23 hours ago — still within window).
    // created_at = now() - 29 days - 23 hours → cutoff = now() - 30 days
    // now() - 29d - 23h > cutoff → NOT eligible → must survive.
    const freshId = await withOrgContext(db7, seed.orgAId, async (tx) => {
      const result = await (tx as PgliteTestClient).execute(sql`
        INSERT INTO booking_request (
          org_id, status, requester_name, requester_email,
          requested_start, created_at, updated_at
        ) VALUES (
          ${seed.orgAId}::uuid,
          'new',
          'Fresh Row',
          'fresh@test.example',
          '2027-06-01T10:00:00Z'::timestamptz,
          now() - make_interval(days => 29, hours => 23),
          now() - make_interval(days => 29, hours => 23)
        )
        RETURNING id
      `);
      const rows = result.rows as Array<{ id: string }>;
      return rows[0]!.id;
    });

    // Insert a row well before the cutoff (should be deleted).
    const expiredId = await insertBookingRequestAt(db7, seed.orgAId, {
      status: 'new',
      createdAt: '2000-01-01T00:00:00Z',
    });

    await purgeExpiredBookingRequestsWithDb(db7, session, { dryRun: false });

    // The fresh row (inside the retention window) must survive.
    const freshExists = await rowExists(db7, seed.orgAId, freshId);
    expect(freshExists).toBe(true);

    // The old row (well before the cutoff) must be gone.
    const expiredExists = await rowExists(db7, seed.orgAId, expiredId);
    expect(expiredExists).toBe(false);
  }, 30_000);

  it('PURGE-6: converted excluded by default (status=converted not deleted)', async () => {
    const { pglite: pg8, db: db8 } = await createTestClient();
    await applyMigrationSql({ pglite: pg8 }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db8);
    await setTestAppRole({ pglite: pg8 });

    const session = makeSession('owner', seed.orgAId, seed.userAId);
    // includesConverted=false (the default).
    await setBookingRetentionWithDb(db8, session, {
      retentionDays: 1,
      includesConverted: false,
    });

    // Insert an expired 'new' row and an expired 'converted' row.
    const newId = await insertBookingRequestAt(db8, seed.orgAId, {
      status: 'new',
      createdAt: '2000-01-01T00:00:00Z',
    });

    // For 'converted' we need handled_at (shape check requires it).
    const convertedId = await withOrgContext(db8, seed.orgAId, async (tx) => {
      const result = await (tx as PgliteTestClient).execute(sql`
        INSERT INTO booking_request (
          org_id, status, requester_name, requester_email,
          requested_start, created_at, updated_at, handled_at
        ) VALUES (
          ${seed.orgAId}::uuid,
          'converted',
          'Converted Requester',
          'converted@test.example',
          '2027-06-01T10:00:00Z'::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz
        )
        RETURNING id
      `);
      const rows = result.rows as Array<{ id: string }>;
      return rows[0]!.id;
    });

    await purgeExpiredBookingRequestsWithDb(db8, session, { dryRun: false });

    // 'new' row must be deleted.
    expect(await rowExists(db8, seed.orgAId, newId)).toBe(false);
    // 'converted' row must survive (includesConverted=false).
    expect(await rowExists(db8, seed.orgAId, convertedId)).toBe(true);
  }, 30_000);

  it('PURGE-7: converted included when flag=true (status=converted deleted with others)', async () => {
    const { pglite: pg9, db: db9 } = await createTestClient();
    await applyMigrationSql({ pglite: pg9 }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db9);
    await setTestAppRole({ pglite: pg9 });

    const session = makeSession('owner', seed.orgAId, seed.userAId);
    await setBookingRetentionWithDb(db9, session, {
      retentionDays: 1,
      includesConverted: true, // include converted
    });

    // Insert expired 'converted' row.
    const convertedId = await withOrgContext(db9, seed.orgAId, async (tx) => {
      const result = await (tx as PgliteTestClient).execute(sql`
        INSERT INTO booking_request (
          org_id, status, requester_name, requester_email,
          requested_start, created_at, updated_at, handled_at
        ) VALUES (
          ${seed.orgAId}::uuid,
          'converted',
          'Conv Inc',
          'conv-inc@test.example',
          '2027-06-01T10:00:00Z'::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz
        )
        RETURNING id
      `);
      const rows = result.rows as Array<{ id: string }>;
      return rows[0]!.id;
    });

    await purgeExpiredBookingRequestsWithDb(db9, session, { dryRun: false });

    // 'converted' row must be deleted when flag=true.
    expect(await rowExists(db9, seed.orgAId, convertedId)).toBe(false);
  }, 30_000);

  it('PURGE-8: linked reservation survives when booking_request is purged (no cascade up)', async () => {
    const { pglite: pg10, db: db10 } = await createTestClient();
    await applyMigrationSql({ pglite: pg10 }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db10);
    await setTestAppRole({ pglite: pg10 });

    const session = makeSession('owner', seed.orgAId, seed.userAId);
    await setBookingRetentionWithDb(db10, session, {
      retentionDays: 1,
      includesConverted: true, // purge converted too
    });

    // Create a reservation to link to.
    let reservationId: string;
    await withOrgContext(db10, seed.orgAId, async (tx) => {
      const result = await (tx as PgliteTestClient).execute(sql`
        INSERT INTO reservation (org_id, start_at, end_at, created_by)
        VALUES (
          ${seed.orgAId}::uuid,
          '2027-07-01T10:00:00Z'::timestamptz,
          '2027-07-01T12:00:00Z'::timestamptz,
          ${seed.userAId}::uuid
        )
        RETURNING id
      `);
      reservationId = (result.rows as Array<{ id: string }>)[0]!.id;
    });

    // Create a converted booking_request linked to the reservation.
    const brId = await withOrgContext(db10, seed.orgAId, async (tx) => {
      const result = await (tx as PgliteTestClient).execute(sql`
        INSERT INTO booking_request (
          org_id, status, requester_name, requester_email,
          requested_start, created_at, updated_at, handled_at,
          converted_reservation_id
        ) VALUES (
          ${seed.orgAId}::uuid,
          'converted',
          'Linked Conv',
          'linked@test.example',
          '2027-06-01T10:00:00Z'::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz,
          ${reservationId!}::uuid
        )
        RETURNING id
      `);
      const rows = result.rows as Array<{ id: string }>;
      return rows[0]!.id;
    });

    await purgeExpiredBookingRequestsWithDb(db10, session, { dryRun: false });

    // booking_request is deleted.
    expect(await rowExists(db10, seed.orgAId, brId)).toBe(false);

    // Reservation SURVIVES (no cascade up from booking_request → reservation).
    const rsvExists = await withOrgContext(db10, seed.orgAId, async (tx) => {
      const result = await (tx as PgliteTestClient).execute(sql`
        SELECT 1 FROM reservation WHERE id = ${reservationId!}::uuid
      `);
      return result.rows.length > 0;
    });
    expect(rsvExists).toBe(true);
  }, 30_000);

  it('PURGE-9: idempotency — 2nd apply deletes 0 rows', async () => {
    const { pglite: pg11, db: db11 } = await createTestClient();
    await applyMigrationSql({ pglite: pg11 }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db11);
    await setTestAppRole({ pglite: pg11 });

    const session = makeSession('owner', seed.orgAId, seed.userAId);
    await setBookingRetentionWithDb(db11, session, { retentionDays: 1, includesConverted: false });
    await insertBookingRequestAt(db11, seed.orgAId, { status: 'new', createdAt: '2000-01-01T00:00:00Z' });

    const first = await purgeExpiredBookingRequestsWithDb(db11, session, { dryRun: false });
    expect(first.deletedCount).toBeGreaterThan(0);

    const second = await purgeExpiredBookingRequestsWithDb(db11, session, { dryRun: false });
    expect(second.deletedCount).toBe(0);
  }, 30_000);

  it('PURGE-10: eligible statuses (new/contacted/declined) deleted; converted not (default)', async () => {
    const { pglite: pg12, db: db12 } = await createTestClient();
    await applyMigrationSql({ pglite: pg12 }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(db12);
    await setTestAppRole({ pglite: pg12 });

    const session = makeSession('owner', seed.orgAId, seed.userAId);
    await setBookingRetentionWithDb(db12, session, {
      retentionDays: 1,
      includesConverted: false,
    });

    const newId = await insertBookingRequestAt(db12, seed.orgAId, {
      status: 'new', createdAt: '2000-01-01T00:00:00Z',
    });

    // 'contacted' requires handled_at.
    const contactedId = await withOrgContext(db12, seed.orgAId, async (tx) => {
      const result = await (tx as PgliteTestClient).execute(sql`
        INSERT INTO booking_request (org_id, status, requester_name, requester_email,
          requested_start, created_at, updated_at, handled_at)
        VALUES (${seed.orgAId}::uuid, 'contacted', 'Contacted', 'cont@test.example',
          '2027-06-01T10:00:00Z'::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz, '2000-01-01T00:00:00Z'::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz)
        RETURNING id
      `);
      return (result.rows as Array<{ id: string }>)[0]!.id;
    });

    // 'declined' requires handled_at.
    const declinedId = await withOrgContext(db12, seed.orgAId, async (tx) => {
      const result = await (tx as PgliteTestClient).execute(sql`
        INSERT INTO booking_request (org_id, status, requester_name, requester_email,
          requested_start, created_at, updated_at, handled_at)
        VALUES (${seed.orgAId}::uuid, 'declined', 'Declined', 'decl@test.example',
          '2027-06-01T10:00:00Z'::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz, '2000-01-01T00:00:00Z'::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz)
        RETURNING id
      `);
      return (result.rows as Array<{ id: string }>)[0]!.id;
    });

    // 'converted' not included.
    const convertedId = await withOrgContext(db12, seed.orgAId, async (tx) => {
      const result = await (tx as PgliteTestClient).execute(sql`
        INSERT INTO booking_request (org_id, status, requester_name, requester_email,
          requested_start, created_at, updated_at, handled_at)
        VALUES (${seed.orgAId}::uuid, 'converted', 'Conv', 'conv@test.example',
          '2027-06-01T10:00:00Z'::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz, '2000-01-01T00:00:00Z'::timestamptz,
          '2000-01-01T00:00:00Z'::timestamptz)
        RETURNING id
      `);
      return (result.rows as Array<{ id: string }>)[0]!.id;
    });

    await purgeExpiredBookingRequestsWithDb(db12, session, { dryRun: false });

    expect(await rowExists(db12, seed.orgAId, newId)).toBe(false);
    expect(await rowExists(db12, seed.orgAId, contactedId)).toBe(false);
    expect(await rowExists(db12, seed.orgAId, declinedId)).toBe(false);
    expect(await rowExists(db12, seed.orgAId, convertedId)).toBe(true);
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// T-ISO — Tenant isolation (RLS)
// ═════════════════════════════════════════════════════════════════════════════

describe('T-ISO — Tenant isolation under enforced RLS', () => {
  it('T-ISO-1 HEADLINE: org A purge deletes ONLY org A rows; org B rows untouched', async () => {
    const { pglite: pgIso, db: dbIso } = await createTestClient();
    await applyMigrationSql({ pglite: pgIso }, MIGRATION_SQL);
    const seed = await seedTwoOrgs(dbIso);
    await setTestAppRole({ pglite: pgIso });

    const sessionA = makeSession('owner', seed.orgAId, seed.userAId);
    const sessionB = makeSession('owner', seed.orgBId, seed.userBId);

    // Set both orgs to 1-day retention.
    await setBookingRetentionWithDb(dbIso, sessionA, { retentionDays: 1, includesConverted: false });
    await setBookingRetentionWithDb(dbIso, sessionB, { retentionDays: 1, includesConverted: false });

    // Insert expired rows in both orgs.
    const aId = await insertBookingRequestAt(dbIso, seed.orgAId, {
      status: 'new', createdAt: '2000-01-01T00:00:00Z',
    });
    const bId = await insertBookingRequestAt(dbIso, seed.orgBId, {
      status: 'new', createdAt: '2000-01-01T00:00:00Z',
    });

    // Purge as org A — must NOT touch org B rows.
    const result = await purgeExpiredBookingRequestsWithDb(dbIso, sessionA, { dryRun: false });
    expect(result.ok).toBe(true);

    // Org A row deleted.
    const aExists = await withOrgContext(dbIso, seed.orgAId, async (tx) => {
      const r = await (tx as PgliteTestClient).execute(sql`
        SELECT 1 FROM booking_request WHERE id = ${aId}::uuid
      `);
      return r.rows.length > 0;
    });
    expect(aExists).toBe(false);

    // Org B row intact.
    const bExists = await withOrgContext(dbIso, seed.orgBId, async (tx) => {
      const r = await (tx as PgliteTestClient).execute(sql`
        SELECT 1 FROM booking_request WHERE id = ${bId}::uuid
      `);
      return r.rows.length > 0;
    });
    expect(bExists).toBe(true);
  }, 30_000);

  it('T-ISO-2: getter for org A returns org A config (not org B config)', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = env;
    const sessionA = makeSession('owner', orgAId, userAId);
    const sessionB = makeSession('owner', orgBId, userBId);

    await setBookingRetentionWithDb(db, sessionA, { retentionDays: 111, includesConverted: false });
    await setBookingRetentionWithDb(db, sessionB, { retentionDays: 222, includesConverted: true });

    const gotA = await getBookingRetentionWithDb(db, sessionA);
    const gotB = await getBookingRetentionWithDb(db, sessionB);

    expect(gotA.retentionDays).toBe(111);
    expect(gotB.retentionDays).toBe(222);
    expect(gotA.retentionDays).not.toBe(gotB.retentionDays);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PROP — Property test
// ═════════════════════════════════════════════════════════════════════════════

describe('PROP — Property test: deleted set exactly matches predicate', () => {
  it('PROP-1: deleted rows == { created_at < cutoff AND status IN eligible }; never another org', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Arbitrary retention days 1–30.
        fc.integer({ min: 1, max: 30 }),
        // Whether to include converted.
        fc.boolean(),
        async (retentionDays, includesConverted) => {
          const { pglite: pgProp, db: dbProp } = await createTestClient();
          await applyMigrationSql({ pglite: pgProp }, MIGRATION_SQL);
          const seed = await seedTwoOrgs(dbProp);
          await setTestAppRole({ pglite: pgProp });

          const sessionA = makeSession('owner', seed.orgAId, seed.userAId);
          await setBookingRetentionWithDb(dbProp, sessionA, {
            retentionDays,
            includesConverted,
          });

          // Insert rows with various statuses far in the past (eligible).
          const eligibleStatuses = ['new', 'contacted', 'declined'];
          if (includesConverted) eligibleStatuses.push('converted');
          const ineligibleStatuses = includesConverted ? [] : ['converted'];

          const expiredEligibleIds: string[] = [];
          const expiredIneligibleIds: string[] = [];

          for (const status of eligibleStatuses) {
            const id = await withOrgContext(dbProp, seed.orgAId, async (tx) => {
              const result = await (tx as PgliteTestClient).execute(sql`
                INSERT INTO booking_request (
                  org_id, status, requester_name, requester_email,
                  requested_start, created_at, updated_at, handled_at
                ) VALUES (
                  ${seed.orgAId}::uuid,
                  ${status},
                  ${`Requester ${status}`},
                  ${`${status}@test.example`},
                  '2027-06-01T10:00:00Z'::timestamptz,
                  '2000-01-01T00:00:00Z'::timestamptz,
                  '2000-01-01T00:00:00Z'::timestamptz,
                  ${status === 'new' ? null : '2000-01-01T00:00:00Z'}::timestamptz
                )
                RETURNING id
              `);
              return (result.rows as Array<{ id: string }>)[0]!.id;
            });
            expiredEligibleIds.push(id);
          }

          for (const status of ineligibleStatuses) {
            const id = await withOrgContext(dbProp, seed.orgAId, async (tx) => {
              const result = await (tx as PgliteTestClient).execute(sql`
                INSERT INTO booking_request (
                  org_id, status, requester_name, requester_email,
                  requested_start, created_at, updated_at, handled_at
                ) VALUES (
                  ${seed.orgAId}::uuid,
                  ${status},
                  'Ineligible',
                  'ineligible@test.example',
                  '2027-06-01T10:00:00Z'::timestamptz,
                  '2000-01-01T00:00:00Z'::timestamptz,
                  '2000-01-01T00:00:00Z'::timestamptz,
                  '2000-01-01T00:00:00Z'::timestamptz
                )
                RETURNING id
              `);
              return (result.rows as Array<{ id: string }>)[0]!.id;
            });
            expiredIneligibleIds.push(id);
          }

          // Insert a row in org B (must NEVER be deleted by org A's purge).
          const orgBId = await withOrgContext(dbProp, seed.orgBId, async (tx) => {
            const result = await (tx as PgliteTestClient).execute(sql`
              INSERT INTO booking_request (
                org_id, status, requester_name, requester_email,
                requested_start, created_at, updated_at
              ) VALUES (
                ${seed.orgBId}::uuid, 'new', 'Org B Victim', 'victim@b.example',
                '2027-06-01T10:00:00Z'::timestamptz,
                '2000-01-01T00:00:00Z'::timestamptz,
                '2000-01-01T00:00:00Z'::timestamptz
              )
              RETURNING id
            `);
            return (result.rows as Array<{ id: string }>)[0]!.id;
          });

          // Run the purge for org A.
          const result = await purgeExpiredBookingRequestsWithDb(dbProp, sessionA, { dryRun: false });
          expect(result.ok).toBe(true);

          // All eligible org A rows must be deleted.
          for (const id of expiredEligibleIds) {
            const exists = await withOrgContext(dbProp, seed.orgAId, async (tx) => {
              const r = await (tx as PgliteTestClient).execute(sql`
                SELECT 1 FROM booking_request WHERE id = ${id}::uuid
              `);
              return r.rows.length > 0;
            });
            expect(exists).toBe(false);
          }

          // Ineligible org A rows must survive.
          for (const id of expiredIneligibleIds) {
            const exists = await withOrgContext(dbProp, seed.orgAId, async (tx) => {
              const r = await (tx as PgliteTestClient).execute(sql`
                SELECT 1 FROM booking_request WHERE id = ${id}::uuid
              `);
              return r.rows.length > 0;
            });
            expect(exists).toBe(true);
          }

          // Org B row must survive (cross-org isolation guarantee).
          const bExists = await withOrgContext(dbProp, seed.orgBId, async (tx) => {
            const r = await (tx as PgliteTestClient).execute(sql`
              SELECT 1 FROM booking_request WHERE id = ${orgBId}::uuid
            `);
            return r.rows.length > 0;
          });
          expect(bExists).toBe(true);
        },
      ),
      { numRuns: 5 }, // Keep low to avoid test timeout (each run spins up a new PGlite)
    );
  }, 120_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// SCHEMA-0017 — DB schema for migration 0017
// ═════════════════════════════════════════════════════════════════════════════

describe('SCHEMA-0017 — booking_request_retention_days columns + CHECK + down migration', () => {
  it('SCHEMA-1: booking_request_retention_days column exists on dispatch_config', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_config'
           AND column_name = 'booking_request_retention_days'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  it('SCHEMA-2: booking_request_retention_includes_converted column exists on dispatch_config', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_config'
           AND column_name = 'booking_request_retention_includes_converted'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  it('SCHEMA-3: CHECK rejects booking_request_retention_days = -1', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO dispatch_config (org_id, booking_request_retention_days)
         VALUES ($1, -1)
         ON CONFLICT (org_id) DO UPDATE SET booking_request_retention_days = -1`,
        [orgAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('SCHEMA-4: CHECK rejects booking_request_retention_days = 3651', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO dispatch_config (org_id, booking_request_retention_days)
         VALUES ($1, 3651)
         ON CONFLICT (org_id) DO UPDATE SET booking_request_retention_days = 3651`,
        [orgAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('SCHEMA-5: CHECK accepts booking_request_retention_days = 0', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await expect(
      pglite.query(
        `UPDATE dispatch_config SET booking_request_retention_days = 0 WHERE org_id = $1`,
        [orgAId],
      ),
    ).resolves.not.toThrow();
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('SCHEMA-6: CHECK accepts booking_request_retention_days = 3650', async () => {
    const { pglite, orgAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await expect(
      pglite.query(
        `UPDATE dispatch_config SET booking_request_retention_days = 3650 WHERE org_id = $1`,
        [orgAId],
      ),
    ).resolves.not.toThrow();
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('SCHEMA-7: down migration removes columns + constraint; table remains', async () => {
    const { pglite: pgDown } = await createTestClient();
    await applyMigrationSql({ pglite: pgDown }, MIGRATION_SQL);

    // Verify columns exist before down.
    const beforeDays = await pgDown.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_config'
           AND column_name = 'booking_request_retention_days'
       ) AS exists`,
    );
    expect(beforeDays.rows[0]!.exists).toBe(true);

    const beforeConv = await pgDown.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_config'
           AND column_name = 'booking_request_retention_includes_converted'
       ) AS exists`,
    );
    expect(beforeConv.rows[0]!.exists).toBe(true);

    // Apply the down migration.
    await pgDown.exec(DOWN_0017);

    // Both columns must be gone.
    const afterDays = await pgDown.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_config'
           AND column_name = 'booking_request_retention_days'
       ) AS exists`,
    );
    expect(afterDays.rows[0]!.exists).toBe(false);

    const afterConv = await pgDown.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_config'
           AND column_name = 'booking_request_retention_includes_converted'
       ) AS exists`,
    );
    expect(afterConv.rows[0]!.exists).toBe(false);

    // dispatch_config table itself must still exist.
    const tableExists = await pgDown.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'dispatch_config'
       ) AS exists`,
    );
    expect(tableExists.rows[0]!.exists).toBe(true);
  }, 30_000);
});
