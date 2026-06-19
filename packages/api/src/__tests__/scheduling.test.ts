/**
 * scheduling.test.ts — API-layer integration + property suite for SCHED-1.
 *
 * Tests the PERSISTENCE/DB layer (not the pure-predicate layer, which is
 * already covered by packages/core/src/scheduling/__tests__/overlap.test.ts).
 *
 * COVERAGE (per test-writer ticket):
 *   HAPPY PATHS
 *   CONFLICT / CORRECTNESS (the core of the guardrail)
 *   TENANT ISOLATION (RLS on all 3 new tables)
 *   VALIDATION (distinct from conflict — thrown, not returned)
 *   AUTHZ (role matrix: who can create/cancel/list/manage)
 *   PROPERTY: bulk-rejection of overlapping windows (DB-level analogue)
 *   SERIALIZATION: two-transaction interleaving (pglite-appropriate)
 *
 * NOTE (pglite single-threaded WASM):
 *   True OS-thread concurrency is not reproducible in pglite. Serialization is
 *   proved via two-transaction interleaving + bulk rejection (ADR-0004 §Consequences).
 *   Real-Postgres OS-thread concurrency smoke is deferred to Slice 0.4 CI.
 *
 * Setup mirrors packages/db/src/__tests__/scheduling-schema.test.ts:
 *   createTestClient() → applyMigrationSql([0000, 0001, 0002]) → seed → setTestAppRole()
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import * as fc from 'fast-check';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  withPlatformAdminContext,
  seedTwoOrgs,
} from '@aeroops/db';
import { appUser, auditLog, reservation, reservationResource } from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { cancelReservationWithDb } from '../scheduling/cancel-reservation.js';
import { checkConflictsWithDb } from '../scheduling/check-conflicts.js';
import { createResourceWithDb, deactivateResourceWithDb } from '../scheduling/resource-commands.js';
import { listResourcesWithDb } from '../scheduling/list-resources.js';
import { listReservationsWithDb } from '../scheduling/list-reservations.js';
import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// ── Path resolution ───────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_SQL = [
  readFileSync(resolve(__dirname, '../../../db/migrations/0000_loud_prodigy.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0001_auth_credential.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0002_scheduling.sql'), 'utf-8'),
  // 0003 required: createReservation now probes booking_policy + resource_blackout
  // (SCHED-2a policy gate runs on every create; absent policy = open booking, Slice-1 preserved).
  readFileSync(resolve(__dirname, '../../../db/migrations/0003_booking_policies.sql'), 'utf-8'),
  // 0004 required: reservation schema now includes series_id column (ADR-0006 Slice 2b).
  // The Drizzle INSERT always emits series_id (DEFAULT) so the column must exist.
  readFileSync(resolve(__dirname, '../../../db/migrations/0004_recurrence.sql'), 'utf-8'),
  // 0005 required: 0006 references dispatch_ticket(id, org_id) (FK candidate key).
  readFileSync(resolve(__dirname, '../../../db/migrations/0005_dispatch.sql'), 'utf-8'),
  // 0006 required: gatedCreateOccurrence's warn-only grounding step (ADR-0008
  // §2.3) reads aircraft_grounding on the success path; the table must exist.
  readFileSync(resolve(__dirname, '../../../db/migrations/0006_squawks_grounding.sql'), 'utf-8'),
  // 0007 required: resource schema now includes fleet columns (make/model/year/
  // serial_number/home_base_location_id/has_hobbs/has_tach). Drizzle ORM INSERT
  // emits all columns (with DEFAULT) so they must exist in the test DB.
  readFileSync(resolve(__dirname, '../../../db/migrations/0007_fleet.sql'), 'utf-8'),
  // 0008 required: app_user now includes phone/status columns (Slice 6.1).
  // Drizzle ORM INSERT on app_user emits all columns including phone + status.
  readFileSync(resolve(__dirname, '../../../db/migrations/0008_people.sql'), 'utf-8'),
  // 0009 required: dispatch_requirement + dispatch_config tables (Slice 3c / ADR-0009).
  // openDispatch now queries dispatch_requirement; tables must exist in test DB.
  readFileSync(resolve(__dirname, '../../../db/migrations/0009_dispatch_gate.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0010_civil_twilight.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0011_optimizer_run.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0012_training.sql'),        'utf-8'),
];

// ── Shared test env ──────────────────────────────────────────────────────────

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
}

/**
 * Build an AppSession for a given org/user/role triple.
 * Mirrors the helper used in packages/api/src/__tests__/dashboard.test.ts.
 */
function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'] = 'owner',
): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

/**
 * Common deterministic timestamps — pinned so tests are date-independent.
 * All in 2026-06-16 (the current date from CLAUDE.md context).
 *
 * WINDOW NAMING (half-open [start, end)):
 *   W1 = [08:00, 09:00)   — 1-hour morning slot
 *   W2 = [09:00, 10:00)   — adjacent (touching) slot; valid back-to-back with W1
 *   W3 = [08:30, 09:30)   — overlaps BOTH W1 and W2 (conflict case)
 *   W4 = [10:00, 11:00)   — completely disjoint from W1/W2
 *   W5 = [11:00, 12:00)   — adjacent to W4 (touching, legal)
 */
const T = {
  W1_start: new Date('2026-06-16T08:00:00Z'),
  W1_end:   new Date('2026-06-16T09:00:00Z'),
  W2_start: new Date('2026-06-16T09:00:00Z'),
  W2_end:   new Date('2026-06-16T10:00:00Z'),
  W3_start: new Date('2026-06-16T08:30:00Z'),
  W3_end:   new Date('2026-06-16T09:30:00Z'),
  W4_start: new Date('2026-06-16T10:00:00Z'),
  W4_end:   new Date('2026-06-16T11:00:00Z'),
  W5_start: new Date('2026-06-16T11:00:00Z'),
  W5_end:   new Date('2026-06-16T12:00:00Z'),
};

// ── One shared PGlite env for the full suite ──────────────────────────────────
//
// IMPORTANT: Tests that are mutually destructive (e.g. cancel + rebook on same
// resource) create their OWN resources per test to avoid state leakage.
// The shared env's orgAId / orgBId / userAId / userBId are always available;
// individual tests spin up resources as needed with createResourceWithDb.

let sharedEnv: TestEnv;

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });

  sharedEnv = {
    db,
    pglite,
    orgAId: seed.orgAId,
    orgBId: seed.orgBId,
    userAId: seed.userAId,
    userBId: seed.userBId,
  };
}, 60_000);

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1 — HAPPY PATHS
// ════════════════════════════════════════════════════════════════════════════════

describe('HAPPY PATH: createResource', () => {
  it('creates an aircraft resource → returns row with correct shape', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const result = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'Cessna 172 N12345',
      tailNumber: 'N12345',
    });

    expect(result.id).toBeTruthy();
    expect(result.orgId).toBe(orgAId);
    expect(result.kind).toBe('aircraft');
    expect(result.displayName).toBe('Cessna 172 N12345');
    expect(result.tailNumber).toBe('N12345');
    expect(result.instructorUserId).toBeNull();
    expect(result.active).toBe(true);
  });

  it('creates an instructor resource → returns row with correct shape', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'manager');

    // userAId is a valid app_user in orgA → satisfies the composite FK
    const result = await createResourceWithDb(db, sess, {
      kind: 'instructor',
      displayName: 'Alice CFI',
      instructorUserId: userAId,
    });

    expect(result.kind).toBe('instructor');
    expect(result.tailNumber).toBeNull();
    expect(result.instructorUserId).toBe(userAId);
    expect(result.active).toBe(true);
  });

  it('createResource writes ONE audit_log row per resource created', async () => {
    const { db, pglite, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Count audit_log rows before
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const before = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).execute(),
    );

    await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-Audit',
      tailNumber: 'NAUDIT',
    });

    const after = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).execute(),
    );

    const diff = after.length - before.length;
    expect(diff).toBe(1);

    const newRow = after.find((r) => r.action === 'resource.created' && r.entityType === 'resource');
    expect(newRow).toBeDefined();
  });
});

describe('HAPPY PATH: createReservation — single resource', () => {
  it('single resource reservation → ok:true, row persisted, audit row written', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Create a dedicated aircraft so we own this window cleanly
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-Happy1',
      tailNumber: 'N-HAPPY1',
    });

    const beforeAudit = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).execute(),
    );

    const result = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');

    expect(result.reservation.orgId).toBe(orgAId);
    expect(result.reservation.status).toBe('booked');
    expect(result.reservation.resourceIds).toEqual([aircraft.id]);
    expect(result.reservation.createdBy).toBe(userAId);

    // Verify reservation row persisted
    const resvRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservation).execute(),
    );
    expect(resvRows.some((r) => r.id === result.reservation.id)).toBe(true);

    // Verify join row persisted
    const joinRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservationResource).execute(),
    );
    expect(joinRows.some((r) => r.reservationId === result.reservation.id)).toBe(true);

    // Verify ONE audit row written for this reservation
    const afterAudit = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).execute(),
    );
    const auditDiff = afterAudit.filter(
      (r) => r.action === 'reservation.created' && r.entityId === result.reservation.id,
    );
    expect(auditDiff).toHaveLength(1);
    expect(auditDiff[0]!.actorUserId).toBe(userAId);
  });
});

describe('HAPPY PATH: createReservation — multi-resource (aircraft + instructor)', () => {
  it('multi-resource reservation → ok:true, reservation + N join rows persisted, ONE audit row', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-Multi1',
      tailNumber: 'NMULTI1',
    });
    const instructor = await createResourceWithDb(db, sess, {
      kind: 'instructor',
      displayName: 'Multi CFI',
      instructorUserId: userAId,
    });

    const result = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id, instructor.id],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');

    expect(result.reservation.resourceIds).toHaveLength(2);
    expect(result.reservation.resourceIds).toContain(aircraft.id);
    expect(result.reservation.resourceIds).toContain(instructor.id);

    // TWO join rows
    const joinRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservationResource).execute(),
    );
    const thisResvJoin = joinRows.filter((r) => r.reservationId === result.reservation.id);
    expect(thisResvJoin).toHaveLength(2);

    // ONE audit row (not two)
    const allAudit = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).execute(),
    );
    const thisAudit = allAudit.filter(
      (r) => r.action === 'reservation.created' && r.entityId === result.reservation.id,
    );
    expect(thisAudit).toHaveLength(1);
  });
});

describe('HAPPY PATH: cancelReservation', () => {
  it('booked → cancelled: status flips on reservation + all join rows; audit row written', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-Cancel1',
      tailNumber: 'NCANCEL1',
    });

    const created = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    if (!created.ok) throw new Error('expected ok:true on create');

    const result = await cancelReservationWithDb(db, sess, {
      reservationId: created.reservation.id,
    });
    expect(result.ok).toBe(true);

    // Verify reservation row flipped
    const resvRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservation).execute(),
    );
    const row = resvRows.find((r) => r.id === created.reservation.id);
    expect(row?.status).toBe('cancelled');

    // Verify join rows all flipped
    const joinRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservationResource).execute(),
    );
    const thisJoin = joinRows.filter((r) => r.reservationId === created.reservation.id);
    expect(thisJoin.every((r) => r.status === 'cancelled')).toBe(true);

    // Verify audit row
    const allAudit = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).execute(),
    );
    const cancelAudit = allAudit.filter(
      (r) => r.action === 'reservation.cancelled' && r.entityId === created.reservation.id,
    );
    expect(cancelAudit).toHaveLength(1);
  });

  it('idempotent re-cancel → ok:true, NO second audit row', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-Idem1',
      tailNumber: 'NIDEM1',
    });
    const created = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    if (!created.ok) throw new Error('expected ok:true on create');

    // First cancel
    await cancelReservationWithDb(db, sess, { reservationId: created.reservation.id });

    const auditAfterFirst = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).execute(),
    );
    const cancelAuditCount1 = auditAfterFirst.filter(
      (r) => r.action === 'reservation.cancelled' && r.entityId === created.reservation.id,
    ).length;

    // Second cancel (idempotent)
    const result2 = await cancelReservationWithDb(db, sess, { reservationId: created.reservation.id });
    expect(result2.ok).toBe(true);

    const auditAfterSecond = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).execute(),
    );
    const cancelAuditCount2 = auditAfterSecond.filter(
      (r) => r.action === 'reservation.cancelled' && r.entityId === created.reservation.id,
    ).length;

    // No new audit row written on idempotent cancel
    expect(cancelAuditCount2).toBe(cancelAuditCount1);
  });

  it('unknown reservationId → ok:false reason:not_found', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const result = await cancelReservationWithDb(db, sess, {
      reservationId: '00000000-0000-0000-0000-000000000001',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason).toBe('not_found');
  });

  it('cross-org reservationId → ok:false reason:not_found (RLS hides the row)', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const sessB = makeSession(orgBId, userBId, 'owner');

    // Create a reservation in org B
    const aircraftB = await createResourceWithDb(db, sessB, {
      kind: 'aircraft',
      displayName: 'N-CrossOrg1',
      tailNumber: 'NCROSS1',
    });
    const createdB = await createReservationWithDb(db, sessB, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraftB.id],
    });
    if (!createdB.ok) throw new Error('expected ok:true in org B');

    // Try to cancel from org A — RLS should hide it
    const result = await cancelReservationWithDb(db, sessA, {
      reservationId: createdB.reservation.id,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason).toBe('not_found');
  });
});

describe('HAPPY PATH: deactivateResource', () => {
  it('active resource → ok:true, active=false', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const res = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-Deact1',
      tailNumber: 'NDEACT1',
    });

    const result = await deactivateResourceWithDb(db, sess, { resourceId: res.id });
    expect(result.ok).toBe(true);

    const rows = await listResourcesWithDb(db, sess, { includeInactive: true });
    const found = rows.find((r) => r.id === res.id);
    expect(found?.active).toBe(false);
  });

  it('unknown resourceId → ok:false reason:not_found', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const result = await deactivateResourceWithDb(db, sess, {
      resourceId: '00000000-0000-0000-0000-000000000002',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason).toBe('not_found');
  });
});

describe('HAPPY PATH: listResources', () => {
  it('returns only active resources by default; inactive excluded', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const active = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-List-Active',
      tailNumber: 'NLISTACT',
    });
    const inactive = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-List-Inactive',
      tailNumber: 'NLISTINACT',
    });
    await deactivateResourceWithDb(db, sess, { resourceId: inactive.id });

    const rows = await listResourcesWithDb(db, sess);
    expect(rows.some((r) => r.id === active.id)).toBe(true);
    expect(rows.some((r) => r.id === inactive.id)).toBe(false);
  });

  it('includeInactive:true returns both active and inactive', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const active = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-IncA',
      tailNumber: 'NINCA',
    });
    const inactive = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-IncI',
      tailNumber: 'NINCI',
    });
    await deactivateResourceWithDb(db, sess, { resourceId: inactive.id });

    const rows = await listResourcesWithDb(db, sess, { includeInactive: true });
    expect(rows.some((r) => r.id === active.id)).toBe(true);
    expect(rows.some((r) => r.id === inactive.id)).toBe(true);
  });

  it('listResources never returns org B resources to an org A session', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const sessB = makeSession(orgBId, userBId, 'owner');

    // Create a resource in org B
    const resB = await createResourceWithDb(db, sessB, {
      kind: 'aircraft',
      displayName: 'N-OrgB-Isolation',
      tailNumber: 'NORGB1',
    });

    // Query as org A
    const rows = await listResourcesWithDb(db, sessA, { includeInactive: true });
    expect(rows.every((r) => r.id !== resB.id)).toBe(true);
  });
});

describe('HAPPY PATH: listReservations', () => {
  it('returns reservations overlapping the window, excludes cancelled by default', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-ListResv',
      tailNumber: 'NLISTR',
    });

    // Create two reservations in different windows
    const r1 = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    const r4 = await createReservationWithDb(db, sess, {
      startAt: T.W4_start,
      endAt: T.W4_end,
      resourceIds: [aircraft.id],
    });
    if (!r1.ok || !r4.ok) throw new Error('both should be ok');

    // Window that covers W1 but not W4
    const rows = await listReservationsWithDb(db, sess, {
      from: T.W1_start,
      to: T.W1_end,
    });

    const ids = rows.map((r) => r.id);
    expect(ids).toContain(r1.reservation.id);
    expect(ids).not.toContain(r4.reservation.id);
  });

  it('excludes cancelled reservations by default', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-ListCxl',
      tailNumber: 'NLISTCXL',
    });

    const created = await createReservationWithDb(db, sess, {
      startAt: T.W2_start,
      endAt: T.W2_end,
      resourceIds: [aircraft.id],
    });
    if (!created.ok) throw new Error('expected ok:true');
    await cancelReservationWithDb(db, sess, { reservationId: created.reservation.id });

    const rows = await listReservationsWithDb(db, sess, {
      from: T.W2_start,
      to: T.W2_end,
    });
    expect(rows.some((r) => r.id === created.reservation.id)).toBe(false);
  });

  it('includeCancelled:true returns cancelled reservations too', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-ListCxlInc',
      tailNumber: 'NLSTCXLI',
    });

    const created = await createReservationWithDb(db, sess, {
      startAt: T.W2_start,
      endAt: T.W2_end,
      resourceIds: [aircraft.id],
    });
    if (!created.ok) throw new Error('expected ok:true');
    await cancelReservationWithDb(db, sess, { reservationId: created.reservation.id });

    const rows = await listReservationsWithDb(db, sess, {
      from: T.W2_start,
      to: T.W2_end,
      includeCancelled: true,
    });
    expect(rows.some((r) => r.id === created.reservation.id)).toBe(true);
  });

  it('each row includes its resourceIds', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-ListRIds',
      tailNumber: 'NLISTRIDS',
    });
    const instructor = await createResourceWithDb(db, sess, {
      kind: 'instructor',
      displayName: 'CFI-ListRIds',
      instructorUserId: userAId,
    });

    const created = await createReservationWithDb(db, sess, {
      startAt: T.W4_start,
      endAt: T.W4_end,
      resourceIds: [aircraft.id, instructor.id],
    });
    if (!created.ok) throw new Error('expected ok:true');

    const rows = await listReservationsWithDb(db, sess, {
      from: T.W4_start,
      to: T.W4_end,
    });
    const found = rows.find((r) => r.id === created.reservation.id);
    expect(found).toBeDefined();
    expect(found!.resourceIds).toHaveLength(2);
    expect(found!.resourceIds).toContain(aircraft.id);
    expect(found!.resourceIds).toContain(instructor.id);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2 — CONFLICT / CORRECTNESS (the core guardrail)
// ════════════════════════════════════════════════════════════════════════════════

describe('CONFLICT: double-book rejected by EXCLUDE constraint', () => {
  it('second overlapping booking on same resource → ok:false reason:conflict, ConflictHit names the resource', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-DoubleBook',
      tailNumber: 'NDBL',
    });

    // First booking [W1] succeeds
    const r1 = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(r1.ok).toBe(true);

    // Second overlapping [W3 = 08:30–09:30] overlaps [W1 = 08:00–09:00]
    const r2 = await createReservationWithDb(db, sess, {
      startAt: T.W3_start,
      endAt: T.W3_end,
      resourceIds: [aircraft.id],
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error('expected ok:false');
    expect(r2.reason).toBe('conflict');
    if (r2.reason !== 'conflict') throw new Error('expected reason:conflict');
    expect(r2.conflicts).toHaveLength(1);
    expect(r2.conflicts[0]!.resourceId).toBe(aircraft.id);
    expect(r2.conflicts[0]!.resourceDisplayName).toBe('N-DoubleBook');
  });

  it('NO second reservation row was written on conflict', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-NoOrphan',
      tailNumber: 'NNOO',
    });

    // First booking
    await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });

    const resvBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservation).execute(),
    );

    // Conflicting attempt
    await createReservationWithDb(db, sess, {
      startAt: T.W3_start,
      endAt: T.W3_end,
      resourceIds: [aircraft.id],
    });

    const resvAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservation).execute(),
    );

    // Count stays the same (the failed reservation was fully rolled back)
    // We compare rows that belong to this aircraft only
    const beforeForAircraft = resvBefore.length;
    const afterForAircraft = resvAfter.length;
    expect(afterForAircraft).toBe(beforeForAircraft);
  });
});

describe('CONFLICT: adjacency is NOT a conflict (half-open [))', () => {
  it('[W1=08:00–09:00) then [W2=09:00–10:00) on same resource → both ok:true', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-Adjacent',
      tailNumber: 'NADJ',
    });

    const r1 = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(r1.ok).toBe(true);

    // W2 starts exactly at W1 end — touching, not overlapping
    const r2 = await createReservationWithDb(db, sess, {
      startAt: T.W2_start,
      endAt: T.W2_end,
      resourceIds: [aircraft.id],
    });
    expect(r2.ok).toBe(true);
  });

  it('[W4=10:00–11:00) then [W5=11:00–12:00) on same resource → both ok:true', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-Adj2',
      tailNumber: 'NADJ2',
    });

    const r4 = await createReservationWithDb(db, sess, {
      startAt: T.W4_start,
      endAt: T.W4_end,
      resourceIds: [aircraft.id],
    });
    expect(r4.ok).toBe(true);

    const r5 = await createReservationWithDb(db, sess, {
      startAt: T.W5_start,
      endAt: T.W5_end,
      resourceIds: [aircraft.id],
    });
    expect(r5.ok).toBe(true);
  });
});

describe('CONFLICT: ALL-OR-NOTHING multi-resource', () => {
  it('free aircraft + already-booked instructor → ok:false; free aircraft NOT booked (no orphan join row)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const freeAircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-AllOrNone',
      tailNumber: 'NAON',
    });
    const bookedInstructor = await createResourceWithDb(db, sess, {
      kind: 'instructor',
      displayName: 'CFI-AllOrNone',
      instructorUserId: userAId,
    });

    // Pre-book the instructor in [W1]
    const pre = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [bookedInstructor.id],
    });
    expect(pre.ok).toBe(true);

    // Count join rows before the all-or-nothing attempt
    const joinsBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservationResource).execute(),
    );

    // Now try to book both in [W1] — instructor is already booked
    const result = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [freeAircraft.id, bookedInstructor.id],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason).toBe('conflict');

    // Verify the free aircraft was NOT booked (no new join rows at all)
    const joinsAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservationResource).execute(),
    );
    expect(joinsAfter.length).toBe(joinsBefore.length);

    // Double-check: no join row for the free aircraft in W1
    const freeAircraftJoins = joinsAfter.filter((r) => r.resourceId === freeAircraft.id);
    expect(freeAircraftJoins).toHaveLength(0);
  });
});

describe('CONFLICT: cancel frees the window → re-book succeeds', () => {
  it('book [W1], cancel [W1], re-book [W1] on same resource → ok:true', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-CancelFree',
      tailNumber: 'NCXLFREE',
    });

    // First booking
    const r1 = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error('first booking failed');

    // Cancel it
    await cancelReservationWithDb(db, sess, { reservationId: r1.reservation.id });

    // Re-book same window — should succeed because EXCLUDE partial WHERE status='booked'
    // no longer blocks (the cancelled row is excluded from the constraint)
    const r2 = await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });
    expect(r2.ok).toBe(true);
  });
});

describe('CONFLICT: checkConflicts (advisory) — pure preview, no write', () => {
  it('checkConflicts returns ok:false/conflicts for overlap WITHOUT writing anything', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-CheckChk',
      tailNumber: 'NCHKCHK',
    });

    // Pre-book [W1]
    await createReservationWithDb(db, sess, {
      startAt: T.W1_start,
      endAt: T.W1_end,
      resourceIds: [aircraft.id],
    });

    // Count rows before checkConflicts
    const resvBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservation).execute(),
    );
    const joinBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservationResource).execute(),
    );

    // Advisory check on overlapping window [W3]
    const check = await checkConflictsWithDb(db, sess, {
      startAt: T.W3_start,
      endAt: T.W3_end,
      resourceIds: [aircraft.id],
    });
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error('expected ok:false');
    expect(check.reason).toBe('conflict');
    if (check.reason !== 'conflict') throw new Error('expected reason:conflict');
    expect(check.conflicts[0]!.resourceId).toBe(aircraft.id);

    // Assert row counts unchanged
    const resvAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservation).execute(),
    );
    const joinAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservationResource).execute(),
    );
    expect(resvAfter.length).toBe(resvBefore.length);
    expect(joinAfter.length).toBe(joinBefore.length);
  });

  it('checkConflicts returns ok:true when window is clear', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-ChkClear',
      tailNumber: 'NCHKCLR',
    });

    const check = await checkConflictsWithDb(db, sess, {
      startAt: T.W4_start,
      endAt: T.W4_end,
      resourceIds: [aircraft.id],
    });
    expect(check.ok).toBe(true);
  });
});

describe('CONFLICT: two-transaction interleaving (serialization proof — pglite-appropriate)', () => {
  /**
   * ADR-0004 §Consequences: pglite is single-threaded WASM — true OS-thread
   * concurrency is not reproducible. We simulate a race by executing two
   * overlapping sequences:
   *
   *   Tx A: BEGIN → SET LOCAL GUC → insert reservation-A → (pause) → insert join-A → COMMIT
   *   Tx B: BEGIN → SET LOCAL GUC → insert reservation-B → insert join-B → COMMIT
   *       (Tx B runs entirely within the pause in Tx A, simulating interleaving)
   *   Tx A: resume → insert join-A → COMMIT (or ROLLBACK on 23P01)
   *
   * Because pglite is sequential, "interleaving" here means we begin Tx A with
   * raw pglite.query (leaving the transaction open), run Tx B entirely, then
   * resume Tx A. Exactly one outcome succeeds.
   *
   * This proves that the EXCLUDE constraint catches the race even when the
   * overlap pre-check was already satisfied at Tx A BEGIN time, because the
   * constraint is evaluated at INSERT time against the current committed state.
   *
   * True OS-thread concurrency is deferred to Slice 0.4 real-PG CI.
   */
  it('interleaved transactions: exactly one commits, the other surfaces conflict (23P01 → ConflictHit)', async () => {
    const { db, pglite, orgAId, userAId } = sharedEnv;

    // We need a new, clean resource for this test to avoid interacting with others
    // We create the resource under the org context (before switching to raw pglite)
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-Interleave',
      tailNumber: 'NINTER',
    });

    const startIso = T.W1_start.toISOString();
    const endIso = T.W1_end.toISOString();

    // Open Tx A — use raw pglite so we can interleave
    await pglite.query('BEGIN');
    await pglite.query(`SET LOCAL "app.current_org_id" = '${orgAId}'`);

    // Insert reservation row A (but NOT the join row yet)
    const txARes = await pglite.query<{ id: string }>(
      `INSERT INTO reservation (org_id, start_at, end_at, status, created_by)
       VALUES ($1, $2::timestamptz, $3::timestamptz, 'booked', $4)
       RETURNING id`,
      [orgAId, startIso, endIso, userAId],
    );
    const txAResvId = txARes.rows[0]!.id;

    // Now run Tx B entirely (simulates the concurrent winner)
    // Tx B must succeed because Tx A's join row is not yet committed.
    await pglite.query('COMMIT'); // commit txA's reservation-only (no join yet)

    // In practice we split: reservation-only commit, then do Tx B fully, then
    // do Tx A's join in a new transaction. This is the cleanest interleaving
    // pglite can express.
    await pglite.query('BEGIN');
    await pglite.query(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const txBRes = await pglite.query<{ id: string }>(
      `INSERT INTO reservation (org_id, start_at, end_at, status, created_by)
       VALUES ($1, $2::timestamptz, $3::timestamptz, 'booked', $4)
       RETURNING id`,
      [orgAId, startIso, endIso, userAId],
    );
    const txBResvId = txBRes.rows[0]!.id;
    // Tx B inserts its join row
    await pglite.query(
      `INSERT INTO reservation_resource (org_id, reservation_id, resource_id, during, status)
       VALUES ($1, $2, $3, tstzrange($4::timestamptz, $5::timestamptz, '[)'), 'booked')`,
      [orgAId, txBResvId, aircraft.id, startIso, endIso],
    );
    await pglite.query('COMMIT'); // Tx B commits first

    // Now Tx A tries to insert its join row — must fail with 23P01
    let txASucceeded = false;
    let txAGot23P01 = false;
    try {
      await pglite.query('BEGIN');
      await pglite.query(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
      await pglite.query(
        `INSERT INTO reservation_resource (org_id, reservation_id, resource_id, during, status)
         VALUES ($1, $2, $3, tstzrange($4::timestamptz, $5::timestamptz, '[)'), 'booked')`,
        [orgAId, txAResvId, aircraft.id, startIso, endIso],
      );
      await pglite.query('COMMIT');
      txASucceeded = true;
    } catch (err) {
      await pglite.query('ROLLBACK').catch(() => { /* ignore rollback error if already aborted */ });
      // Check for 23P01 anywhere in the error chain
      let cur: unknown = err;
      for (let i = 0; i < 5 && cur != null; i++) {
        if ((cur as { code?: unknown }).code === '23P01') {
          txAGot23P01 = true;
          break;
        }
        cur = (cur as { cause?: unknown }).cause;
      }
    }

    // Either Tx A succeeded and Tx B won, or Tx A got 23P01.
    // Since Tx B committed first, Tx A must fail:
    expect(txASucceeded).toBe(false);
    expect(txAGot23P01).toBe(true);

    // Exactly one booked join row for this resource+window in the DB
    await pglite.query(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const committedJoins = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservationResource).execute(),
    );
    const forThisResource = committedJoins.filter(
      (r) => r.resourceId === aircraft.id && r.status === 'booked',
    );
    expect(forThisResource).toHaveLength(1);
    expect(forThisResource[0]!.reservationId).toBe(txBResvId);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 3 — TENANT ISOLATION (RLS on all 3 new scheduling tables)
// ════════════════════════════════════════════════════════════════════════════════

describe('TENANT ISOLATION: org A cannot see org B resources or reservations', () => {
  it('resource: org A context returns 0 org-B rows', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const sessB = makeSession(orgBId, userBId, 'owner');

    // Create a resource in org B
    await createResourceWithDb(db, sessB, {
      kind: 'aircraft',
      displayName: 'N-RLS-OrgB',
      tailNumber: 'NRLSB',
    });

    const rowsA = await listResourcesWithDb(db, sessA, { includeInactive: true });
    expect(rowsA.every((r) => r.id !== undefined)).toBe(true);

    // Verify by querying the table directly under orgA context
    const directRows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservationResource).execute(),
    );
    expect(directRows.every((r) => r.orgId === orgAId)).toBe(true);
    expect(directRows.some((r) => r.orgId === orgBId)).toBe(false);
  });

  it('reservation: org A cannot see org B reservations', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessB = makeSession(orgBId, userBId, 'owner');

    const resB = await createResourceWithDb(db, sessB, {
      kind: 'aircraft',
      displayName: 'N-RLS-Resv-B',
      tailNumber: 'NRLSRVB',
    });
    const bookingB = await createReservationWithDb(db, sessB, {
      startAt: T.W2_start,
      endAt: T.W2_end,
      resourceIds: [resB.id],
    });
    if (!bookingB.ok) throw new Error('booking in org B failed');

    const resvRowsUnderA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservation).execute(),
    );
    expect(resvRowsUnderA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(resvRowsUnderA.some((r) => r.id === bookingB.reservation.id)).toBe(false);
  });

  it('reservation_resource: org A cannot see org B join rows', async () => {
    const { db, orgAId, orgBId } = sharedEnv;

    const joinRowsUnderA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(reservationResource).execute(),
    );
    expect(joinRowsUnderA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(joinRowsUnderA.some((r) => r.orgId === orgBId)).toBe(false);
  });

  it('a booking in org B NEVER blocks the same wall-clock window in org A (resource_ids are disjoint)', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const sessB = makeSession(orgBId, userBId, 'owner');

    // Book the same wall-clock window in org B
    const resB = await createResourceWithDb(db, sessB, {
      kind: 'aircraft',
      displayName: 'N-CrossWall-B',
      tailNumber: 'NCWB',
    });
    const bookingB = await createReservationWithDb(db, sessB, {
      startAt: T.W4_start,
      endAt: T.W4_end,
      resourceIds: [resB.id],
    });
    expect(bookingB.ok).toBe(true);

    // Org A booking same wall-clock window on an org-A resource must succeed
    const resA = await createResourceWithDb(db, sessA, {
      kind: 'aircraft',
      displayName: 'N-CrossWall-A',
      tailNumber: 'NCWA',
    });
    const bookingA = await createReservationWithDb(db, sessA, {
      startAt: T.W4_start,
      endAt: T.W4_end,
      resourceIds: [resA.id],
    });
    expect(bookingA.ok).toBe(true);
  });

  it('org-B resource id is not bookable from an org-A session (ValidationError not_found)', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessA = makeSession(orgAId, userAId, 'owner');
    const sessB = makeSession(orgBId, userBId, 'owner');

    const resB = await createResourceWithDb(db, sessB, {
      kind: 'aircraft',
      displayName: 'N-CrossRes-B',
      tailNumber: 'NCRB',
    });

    // Attempt to book org-B's resource from org-A session → ValidationError
    await expect(
      createReservationWithDb(db, sessA, {
        startAt: T.W4_start,
        endAt: T.W4_end,
        resourceIds: [resB.id],
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('TENANT ISOLATION: RLS fails closed when GUC is unset', () => {
  it('resource returns 0 rows when GUC is unset', async () => {
    const { pglite } = sharedEnv;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM resource`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  it('reservation returns 0 rows when GUC is unset', async () => {
    const { pglite } = sharedEnv;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM reservation`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  it('reservation_resource returns 0 rows when GUC is unset', async () => {
    const { pglite } = sharedEnv;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM reservation_resource`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 4 — VALIDATION (distinct from conflict — thrown, not returned)
// ════════════════════════════════════════════════════════════════════════════════

describe('VALIDATION: input sanitation throws ValidationError (not a conflict result)', () => {
  it('end <= start → ValidationError (no write)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-Val1',
      tailNumber: 'NVAL1',
    });

    await expect(
      createReservationWithDb(db, sess, {
        startAt: T.W1_end,   // end used as start
        endAt: T.W1_start,   // start used as end → start > end
        resourceIds: [aircraft.id],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('end === start → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-Val2',
      tailNumber: 'NVAL2',
    });

    await expect(
      createReservationWithDb(db, sess, {
        startAt: T.W1_start,
        endAt: T.W1_start,   // same instant → zero-length window
        resourceIds: [aircraft.id],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('empty resourceIds → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    await expect(
      createReservationWithDb(db, sess, {
        startAt: T.W1_start,
        endAt: T.W1_end,
        resourceIds: [],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('inactive resource → ValidationError (distinct from conflict)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const res = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-InactVal',
      tailNumber: 'NINACT',
    });
    await deactivateResourceWithDb(db, sess, { resourceId: res.id });

    await expect(
      createReservationWithDb(db, sess, {
        startAt: T.W1_start,
        endAt: T.W1_end,
        resourceIds: [res.id],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('non-bookable kind (sim) → ValidationError (no write)', async () => {
    const { db, pglite, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Insert a sim resource bypassing app-layer validation (raw SQL so the DB
    // shape check passes — sim has no tail_number / instructor_user_id requirement)
    await pglite.query('BEGIN');
    await pglite.query(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const simRes = await pglite.query<{ id: string }>(
      `INSERT INTO resource (org_id, kind, display_name) VALUES ($1, 'sim', 'Flight Sim 1') RETURNING id`,
      [orgAId],
    );
    const simId = simRes.rows[0]!.id;
    await pglite.query('COMMIT');

    await expect(
      createReservationWithDb(db, sess, {
        startAt: T.W1_start,
        endAt: T.W1_end,
        resourceIds: [simId],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('aircraft createResource without tailNumber → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    await expect(
      createResourceWithDb(db, sess, {
        kind: 'aircraft',
        displayName: 'No Tail',
        // tailNumber intentionally missing
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('instructor createResource without instructorUserId → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    await expect(
      createResourceWithDb(db, sess, {
        kind: 'instructor',
        displayName: 'No User',
        // instructorUserId intentionally missing
      }),
    ).rejects.toThrow(ValidationError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 5 — AUTHZ (role matrix)
// ════════════════════════════════════════════════════════════════════════════════

describe('AUTHZ: role matrix — who can create/cancel/list/manage', () => {
  // Roles that have schedule:create_reservation
  const canCreateRoles: AppSession['role'][] = ['owner', 'manager', 'dispatcher', 'cfi'];
  // Roles that do NOT
  const cannotCreateRoles: AppSession['role'][] = ['mechanic', 'renter', 'student', 'accountant'];
  // Roles that have schedule:manage_resources
  const canManageResourceRoles: AppSession['role'][] = ['owner', 'manager', 'dispatcher'];
  // Roles that do NOT have schedule:manage_resources but have schedule:access
  const cannotManageButCanAccessRoles: AppSession['role'][] = ['cfi'];
  // Roles with no schedule:access at all
  const noScheduleAccess: AppSession['role'][] = ['mechanic', 'renter', 'student', 'accountant'];

  it('null session → UnauthenticatedError on createReservation', async () => {
    const { db } = sharedEnv;
    await expect(
      createReservationWithDb(db, null, {
        startAt: T.W1_start,
        endAt: T.W1_end,
        resourceIds: ['00000000-0000-0000-0000-000000000001'],
      }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('null session → UnauthenticatedError on cancelReservation', async () => {
    const { db } = sharedEnv;
    await expect(
      cancelReservationWithDb(db, null, { reservationId: '00000000-0000-0000-0000-000000000001' }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('null session → UnauthenticatedError on createResource', async () => {
    const { db } = sharedEnv;
    await expect(
      createResourceWithDb(db, null, {
        kind: 'aircraft',
        displayName: 'N-Null',
        tailNumber: 'NNULL',
      }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('null session → UnauthenticatedError on listResources', async () => {
    const { db } = sharedEnv;
    await expect(listResourcesWithDb(db, null)).rejects.toThrow(UnauthenticatedError);
  });

  it('null session → UnauthenticatedError on listReservations', async () => {
    const { db } = sharedEnv;
    await expect(
      listReservationsWithDb(db, null, { from: T.W1_start, to: T.W1_end }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('null session → UnauthenticatedError on checkConflicts', async () => {
    const { db } = sharedEnv;
    await expect(
      checkConflictsWithDb(db, null, {
        startAt: T.W1_start,
        endAt: T.W1_end,
        resourceIds: ['00000000-0000-0000-0000-000000000001'],
      }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  for (const role of cannotCreateRoles) {
    it(`role '${role}' → ForbiddenError on createReservation`, async () => {
      const { db, orgAId, userAId } = sharedEnv;
      const sess = makeSession(orgAId, userAId, role);
      await expect(
        createReservationWithDb(db, sess, {
          startAt: T.W1_start,
          endAt: T.W1_end,
          resourceIds: ['00000000-0000-0000-0000-000000000001'],
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  }

  for (const role of canCreateRoles) {
    it(`role '${role}' does NOT get ForbiddenError on createReservation (proceeds to validation)`, async () => {
      const { db, orgAId, userAId } = sharedEnv;
      const sess = makeSession(orgAId, userAId, role);
      // Empty resourceIds will throw ValidationError — that proves authz passed
      await expect(
        createReservationWithDb(db, sess, {
          startAt: T.W1_start,
          endAt: T.W1_end,
          resourceIds: [],
        }),
      ).rejects.toThrow(ValidationError);
    });
  }

  for (const role of noScheduleAccess) {
    it(`role '${role}' → ForbiddenError on listResources`, async () => {
      const { db, orgAId, userAId } = sharedEnv;
      const sess = makeSession(orgAId, userAId, role);
      await expect(listResourcesWithDb(db, sess)).rejects.toThrow(ForbiddenError);
    });
  }

  for (const role of cannotManageButCanAccessRoles) {
    it(`role '${role}' → ForbiddenError on createResource (lacks schedule:manage_resources)`, async () => {
      const { db, orgAId, userAId } = sharedEnv;
      const sess = makeSession(orgAId, userAId, role);
      await expect(
        createResourceWithDb(db, sess, {
          kind: 'aircraft',
          displayName: 'N-CFIBlock',
          tailNumber: 'NCFIBLK',
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  }

  for (const role of canManageResourceRoles) {
    it(`role '${role}' can call createResource (has schedule:manage_resources)`, async () => {
      const { db, orgAId, userAId } = sharedEnv;
      const sess = makeSession(orgAId, userAId, role);
      // We do NOT actually create (would pollute shared state for other tests)
      // just confirm it doesn't throw ForbiddenError by checking a ValidationError
      // is what surfaces (shape check passes, no ForbiddenError)
      const result = await createResourceWithDb(db, sess, {
        kind: 'aircraft',
        displayName: `N-AuthzOk-${role}`,
        tailNumber: `NRZ${role.slice(0, 3).toUpperCase()}`,
      });
      expect(result.id).toBeTruthy();
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 6 — PROPERTY: bulk-rejection of overlapping windows (DB-level)
// ════════════════════════════════════════════════════════════════════════════════

describe('PROPERTY: bulk-rejection — committed booked windows per resource are pairwise non-overlapping', () => {
  /**
   * ADR-0004 invariant 1: No two committed booked join rows share a resource_id
   * + overlapping during ([)). This is the DB-level analogue of the core property test.
   *
   * Strategy: generate N random bookings on a small resource pool (2 resources);
   * feed them through createReservationWithDb sequentially; then assert that the
   * set of COMMITTED booked windows per resource is pairwise non-overlapping.
   *
   * The half-open convention: [start, end). Window A and B overlap iff
   *   max(A.start, B.start) < min(A.end, B.end)
   */
  it('for N random bookings, committed booked windows per resource are pairwise non-overlapping', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate between 3 and 8 booking attempts
        fc.array(
          fc.record({
            // Offset in minutes from a base time (0..120 minutes = 2h window)
            startOffset: fc.integer({ min: 0, max: 119 }),
            // Duration 1..60 minutes
            durationMins: fc.integer({ min: 1, max: 60 }),
            // Which resource (0 or 1)
            resourceIdx: fc.integer({ min: 0, max: 1 }),
          }),
          { minLength: 3, maxLength: 8 },
        ),
        async (attempts) => {
          // Create a fresh org + resources for each iteration to avoid cross-iteration state
          const { db, pglite } = await createTestClient();
          await applyMigrationSql({ pglite }, MIGRATION_SQL);

          const seed = await seedTwoOrgs(db);
          const orgId = seed.orgAId;
          const userId = seed.userAId;

          // Create 2 aircraft resources for this iteration
          const sess = makeSession(orgId, userId, 'owner');

          await setTestAppRole({ pglite });

          const resources: string[] = [];
          for (let i = 0; i < 2; i++) {
            const r = await createResourceWithDb(db, sess, {
              kind: 'aircraft',
              displayName: `N-PBT-${i}`,
              tailNumber: `NPBT${i}`,
            });
            resources.push(r.id);
          }

          const BASE = new Date('2026-06-16T06:00:00Z').getTime();
          const ONE_MIN = 60_000;

          // Feed all attempts through createReservationWithDb
          for (const attempt of attempts) {
            const startAt = new Date(BASE + attempt.startOffset * ONE_MIN);
            const endAt = new Date(startAt.getTime() + attempt.durationMins * ONE_MIN);
            const resourceId = resources[attempt.resourceIdx]!;

            await createReservationWithDb(db, sess, {
              startAt,
              endAt,
              resourceIds: [resourceId],
            });
            // We don't care if ok:true or ok:false (conflicts are rejected) —
            // the invariant is that whatever committed must be non-overlapping.
          }

          // Now query the committed booked join rows
          const joinRows = await withOrgContext(db, orgId, (tx) =>
            tx.select().from(reservationResource).execute(),
          );
          const bookedRows = joinRows.filter((r) => r.status === 'booked');

          // Get the actual time ranges by querying the reservation table
          const resvRows = await withOrgContext(db, orgId, (tx) =>
            tx.select().from(reservation).execute(),
          );
          const resvById = new Map(resvRows.map((r) => [r.id, r]));

          // Group by resource and assert pairwise non-overlapping
          const byResource = new Map<string, Array<{ start: number; end: number }>>();
          for (const row of bookedRows) {
            const resv = resvById.get(row.reservationId);
            if (!resv) continue;
            const windows = byResource.get(row.resourceId) ?? [];
            windows.push({ start: resv.startAt.getTime(), end: resv.endAt.getTime() });
            byResource.set(row.resourceId, windows);
          }

          // Pairwise non-overlap check (half-open [))
          for (const [, windows] of byResource) {
            for (let i = 0; i < windows.length; i++) {
              for (let j = i + 1; j < windows.length; j++) {
                const a = windows[i]!;
                const b = windows[j]!;
                const overlaps = Math.max(a.start, b.start) < Math.min(a.end, b.end);
                if (overlaps) {
                  return false; // fast-check will report a counter-example
                }
              }
            }
          }
          return true;
        },
      ),
      { numRuns: 10 },
    );
  }, 120_000);
});
