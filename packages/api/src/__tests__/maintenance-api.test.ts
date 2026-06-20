/**
 * maintenance-api.test.ts — API integration tests for DISPATCH-3b (Slice 3b).
 *
 * Tests the persistence/DB layer for grounding + squawk write paths and reads.
 * Applies migrations 0000–0006 (migration 0006 = squawk + aircraft_grounding).
 *
 * COVERAGE (per spec §6 api block):
 *
 * GROUNDING:
 *   ground/unground happy + audit + idempotent (no-ops write zero audit rows)
 *   non-aircraft / inactive / cross-org → ValidationError
 *   getGroundingStatus: latest-per-resource + tie-break by id + RLS + authz
 *   openDispatch grounded block: grounded → {ok:false,reason:'grounded'} no write/audit
 *   after release → openDispatch succeeds
 *
 * SQUAWKS:
 *   reportSquawk happy + audit
 *   severity='grounding' does NOT ground (no aircraft_grounding row)
 *   empty title → ValidationError
 *   updateSquawkStatus: open→resolved, open→deferred happy + audit
 *   re-resolve → not_open
 *   cross-org squawk → not_found
 *   concurrency guard (WHERE status='open')
 *   listSquawks: no-filter, resourceId, status filters
 *   getOpenSquawkCounts: counts + 0 default + multi-resource
 *
 * AUTHZ:
 *   maintenance:ground — cfi lacks it
 *   maintenance:squawk — renter/student lack it
 *   maintenance:access — renter/student lack it
 *   mechanic can ground + squawk but NOT dispatch
 *
 * AUDIT:
 *   exactly one row per mutation; no-ops write zero
 *
 * Setup mirrors dispatch-api.test.ts: createTestClient() →
 * applyMigrationSql([0000–0006]) → seedTwoOrgs → additional seed → setTestAppRole.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
} from '@aeroops/db';
import { auditLog, aircraftGrounding } from '@aeroops/db';
import { eq, and, sql } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { createSeriesWithDb } from '../scheduling/create-series.js';
import { rescheduleReservationWithDb } from '../scheduling/reschedule-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { groundAircraftWithDb } from '../maintenance/ground-aircraft.js';
import { unGroundAircraftWithDb } from '../maintenance/ground-aircraft.js';
import { getGroundingStatusWithDb } from '../maintenance/grounding-status.js';
import { reportSquawkWithDb } from '../maintenance/report-squawk.js';
import { updateSquawkStatusWithDb } from '../maintenance/update-squawk-status.js';
import { listSquawksWithDb, getOpenSquawkCountsWithDb } from '../maintenance/list-squawks.js';
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
  readFileSync(resolve(__dirname, '../../../db/migrations/0003_booking_policies.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0004_recurrence.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0005_dispatch.sql'), 'utf-8'),
  // 0006 required: squawk + aircraft_grounding tables + enums + RLS.
  readFileSync(resolve(__dirname, '../../../db/migrations/0006_squawks_grounding.sql'), 'utf-8'),
  // 0007 required: resource schema now includes fleet columns (Slice 5.1).
  // Drizzle ORM INSERT emits all columns so they must exist in the test DB.
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
  readFileSync(resolve(__dirname, '../../../db/migrations/0013_work_orders.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0014_availability.sql'),     'utf-8'),
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

function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'] = 'owner',
): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

// Reservation window — future slot so booking-policy checks pass.
const D = '2026-08-15';
const T = {
  W1_start: new Date(`${D}T08:00:00Z`),
  W1_end:   new Date(`${D}T10:00:00Z`),
  W2_start: new Date(`${D}T12:00:00Z`),
  W2_end:   new Date(`${D}T14:00:00Z`),
};

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

// ── Helper: seed an aircraft resource in a given org ─────────────────────────

async function seedAircraft(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tag: string,
): Promise<string> {
  const sess = makeSession(orgId, userId, 'owner');
  const aircraft = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `N-MAINT-${tag}`,
    tailNumber: `NM${tag}`,
  });
  return aircraft.id;
}

// ── Helper: seed reservation with aircraft ────────────────────────────────────

async function seedReservationWithAircraft(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  tag: string,
  start = T.W1_start,
  end = T.W1_end,
): Promise<{ aircraftId: string; reservationId: string }> {
  const sess = makeSession(orgId, userId, 'owner');
  const aircraft = await createResourceWithDb(db, sess, {
    kind: 'aircraft',
    displayName: `N-MAINT-${tag}`,
    tailNumber: `NM${tag}`,
  });
  const rResult = await createReservationWithDb(db, sess, {
    startAt: start,
    endAt: end,
    resourceIds: [aircraft.id],
  });
  if (!rResult.ok) throw new Error(`seed reservation failed: ${rResult.reason}`);
  return { aircraftId: aircraft.id, reservationId: rResult.reservation.id };
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1 — AUTHZ: groundAircraft / unGroundAircraft
// ════════════════════════════════════════════════════════════════════════════════

describe('AUTHZ: groundAircraft capability gates', () => {
  it('null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(
      groundAircraftWithDb(db, null, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('renter (no maintenance:ground) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(
      groundAircraftWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('cfi (no maintenance:ground per spec) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'cfi');
    await expect(
      groundAircraftWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('mechanic (maintenance:ground) → passes auth gate (ValidationError for bogus input)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'mechanic');
    // Should pass auth, then fail with ValidationError (no such resource).
    await expect(
      groundAircraftWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('dispatcher (maintenance:ground) → passes auth gate', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'dispatcher');
    await expect(
      groundAircraftWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('unGroundAircraft: null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(
      unGroundAircraftWithDb(db, null, {
        resourceId: '00000000-0000-0000-0000-000000000001',
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('unGroundAircraft: cfi → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'cfi');
    await expect(
      unGroundAircraftWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2 — AUTHZ: maintenance:access gates
// ════════════════════════════════════════════════════════════════════════════════

describe('AUTHZ: maintenance:access gates', () => {
  it('getGroundingStatus: null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(
      getGroundingStatusWithDb(db, null, {
        resourceIds: ['00000000-0000-0000-0000-000000000001'],
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('getGroundingStatus: renter (no maintenance:access) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(
      getGroundingStatusWithDb(db, sess, {
        resourceIds: ['00000000-0000-0000-0000-000000000001'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('getGroundingStatus: student (no maintenance:access) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'student');
    await expect(
      getGroundingStatusWithDb(db, sess, {
        resourceIds: ['00000000-0000-0000-0000-000000000001'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('getGroundingStatus: mechanic (maintenance:access) → passes auth gate', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'mechanic');
    const result = await getGroundingStatusWithDb(db, sess, {
      resourceIds: ['00000000-0000-0000-0000-000000000001'],
    });
    // Passes auth; bogus id → grounded:false (no events).
    expect(result.get('00000000-0000-0000-0000-000000000001')?.grounded).toBe(false);
  });

  it('getGroundingStatus: cfi (maintenance:access) → passes auth gate', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'cfi');
    const result = await getGroundingStatusWithDb(db, sess, {
      resourceIds: ['00000000-0000-0000-0000-000000000001'],
    });
    expect(result.get('00000000-0000-0000-0000-000000000001')?.grounded).toBe(false);
  });

  it('listSquawks: renter → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(listSquawksWithDb(db, sess, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('getOpenSquawkCounts: student → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'student');
    await expect(
      getOpenSquawkCountsWithDb(db, sess, {
        resourceIds: ['00000000-0000-0000-0000-000000000001'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 3 — AUTHZ: maintenance:squawk gates
// ════════════════════════════════════════════════════════════════════════════════

describe('AUTHZ: maintenance:squawk gates', () => {
  it('reportSquawk: null session → UnauthenticatedError', async () => {
    const { db } = sharedEnv;
    await expect(
      reportSquawkWithDb(db, null, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        title: 'Test',
        severity: 'low',
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('reportSquawk: renter (no maintenance:squawk) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(
      reportSquawkWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        title: 'Test',
        severity: 'low',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('reportSquawk: student (no maintenance:squawk) → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'student');
    await expect(
      reportSquawkWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        title: 'Test',
        severity: 'low',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('reportSquawk: cfi (maintenance:squawk) → passes auth gate (ValidationError for bogus resource)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'cfi');
    await expect(
      reportSquawkWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        title: 'Test',
        severity: 'low',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('reportSquawk: mechanic (maintenance:squawk) → passes auth gate', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'mechanic');
    await expect(
      reportSquawkWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        title: 'Test',
        severity: 'low',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('updateSquawkStatus: renter → ForbiddenError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'renter');
    await expect(
      updateSquawkStatusWithDb(db, sess, {
        squawkId: '00000000-0000-0000-0000-000000000001',
        status: 'resolved',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 4 — VALIDATION ERRORS
// ════════════════════════════════════════════════════════════════════════════════

describe('VALIDATION: groundAircraft input', () => {
  it('non-UUID resourceId → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      groundAircraftWithDb(db, sess, {
        resourceId: 'not-a-uuid',
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('empty reason → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      groundAircraftWithDb(db, sess, {
        resourceId: '00000000-0000-0000-0000-000000000001',
        reason: '',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('non-aircraft resource → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const instructor = await createResourceWithDb(db, sess, {
      kind: 'instructor',
      displayName: 'CFI Jones',
      instructorUserId: userAId,
    });
    await expect(
      groundAircraftWithDb(db, sess, {
        resourceId: instructor.id,
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('inactive resource → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraft = await createResourceWithDb(db, sess, {
      kind: 'aircraft',
      displayName: 'N-INACTIVE-GND',
      tailNumber: 'NINACTIVEGND',
    });
    const { deactivateResourceWithDb } = await import('../scheduling/resource-commands.js');
    await deactivateResourceWithDb(db, sess, { resourceId: aircraft.id });
    await expect(
      groundAircraftWithDb(db, sess, {
        resourceId: aircraft.id,
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('cross-org resource → ValidationError (RLS blocks visibility)', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;
    const sessB = makeSession(orgBId, userBId, 'owner');
    const aircraftBId = await seedAircraft(db, orgBId, userBId, 'CROSS1');

    const sessA = makeSession(orgAId, userAId, 'owner');
    await expect(
      groundAircraftWithDb(db, sessA, {
        resourceId: aircraftBId,
        reason: 'cross-org attack',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Suppress unused warning
    void sessB;
  });
});

describe('VALIDATION: reportSquawk input', () => {
  it('empty title → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraftId = await seedAircraft(db, orgAId, userAId, 'SQEMPTY');
    await expect(
      reportSquawkWithDb(db, sess, {
        resourceId: aircraftId,
        title: '',
        severity: 'low',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('whitespace-only title → ValidationError (via Zod min(1))', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const aircraftId = await seedAircraft(db, orgAId, userAId, 'SQWS');
    await expect(
      reportSquawkWithDb(db, sess, {
        resourceId: aircraftId,
        title: '   ',
        severity: 'medium',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('non-aircraft resource (instructor) → ValidationError', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');
    const instructor = await createResourceWithDb(db, sess, {
      kind: 'instructor',
      displayName: 'CFI Brown',
      instructorUserId: userAId,
    });
    await expect(
      reportSquawkWithDb(db, sess, {
        resourceId: instructor.id,
        title: 'Test squawk',
        severity: 'low',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 5 — HAPPY PATH: groundAircraft + unGroundAircraft
// ════════════════════════════════════════════════════════════════════════════════

describe('HAPPY PATH: groundAircraft + audit', () => {
  it('grounds an aircraft → ok:true, state=grounded, audit row written', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'GND1');

    const auditBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(eq(auditLog.entityType, 'aircraft_grounding'))
        .execute(),
    );

    const result = await groundAircraftWithDb(db, sess, {
      resourceId: aircraftId,
      reason: 'Hydraulic leak',
    });

    expect(result.ok).toBe(true);
    expect(result.grounding.state).toBe('grounded');
    expect(result.grounding.reason).toBe('Hydraulic leak');
    expect(result.grounding.resourceId).toBe(aircraftId);
    expect(result.grounding.createdBy).toBe(userAId);
    expect(result.grounding.createdAt).toBeInstanceOf(Date);
    expect(result.alreadyGrounded).toBe(false);

    const auditAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(eq(auditLog.entityType, 'aircraft_grounding'))
        .execute(),
    );
    expect(auditAfter.length - auditBefore.length).toBe(1);
    const auditRow = auditAfter[auditAfter.length - 1]!;
    expect(auditRow.action).toBe('grounding.grounded');
    expect(auditRow.entityId).toBe(result.grounding.id);
    const meta = auditRow.metadata as Record<string, unknown>;
    expect(meta['resourceId']).toBe(aircraftId);
    expect(meta['reason']).toBe('Hydraulic leak');
  });

  it('getGroundingStatus: grounded aircraft → grounded:true + reason + groundedBy', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'GND2');
    await groundAircraftWithDb(db, sess, {
      resourceId: aircraftId,
      reason: 'Bird strike',
    });

    const status = await getGroundingStatusWithDb(db, sess, {
      resourceIds: [aircraftId],
    });

    const entry = status.get(aircraftId);
    expect(entry).toBeDefined();
    expect(entry?.grounded).toBe(true);
    expect(entry?.reason).toBe('Bird strike');
    expect(entry?.groundedBy).toBe(userAId);
    expect(entry?.since).toBeInstanceOf(Date);
    expect(entry?.eventId).toBeDefined();
  });
});

describe('HAPPY PATH: unGroundAircraft + audit', () => {
  it('releases a grounded aircraft → ok:true, state=released, audit row written', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'UNGND1');

    // First ground it.
    await groundAircraftWithDb(db, sess, {
      resourceId: aircraftId,
      reason: 'Oil leak',
    });

    const auditBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(eq(auditLog.action, 'grounding.released'))
        .execute(),
    );

    const result = await unGroundAircraftWithDb(db, sess, {
      resourceId: aircraftId,
      reason: 'Repaired and inspected',
    });

    expect(result.ok).toBe(true);
    expect(result.grounding?.state).toBe('released');
    expect(result.alreadyReleased).toBe(false);

    const auditAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(eq(auditLog.action, 'grounding.released'))
        .execute(),
    );
    expect(auditAfter.length - auditBefore.length).toBe(1);
    expect(auditAfter[auditAfter.length - 1]?.action).toBe('grounding.released');
  });

  it('getGroundingStatus after release → grounded:false', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'UNGND2');
    await groundAircraftWithDb(db, sess, { resourceId: aircraftId, reason: 'Test' });
    await unGroundAircraftWithDb(db, sess, { resourceId: aircraftId });

    const status = await getGroundingStatusWithDb(db, sess, { resourceIds: [aircraftId] });
    expect(status.get(aircraftId)?.grounded).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 6 — IDEMPOTENCY (no-ops write zero audit rows)
// ════════════════════════════════════════════════════════════════════════════════

describe('IDEMPOTENCY: groundAircraft + unGroundAircraft', () => {
  it('double-ground: second groundAircraft → alreadyGrounded:true, NO new event, NO audit', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'IDMP1');
    await groundAircraftWithDb(db, sess, { resourceId: aircraftId, reason: 'First ground' });

    // Count rows before second call.
    const eventsBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(aircraftGrounding).where(eq(aircraftGrounding.resourceId, aircraftId)).execute(),
    );
    const auditsBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityType, 'aircraft_grounding')).execute(),
    );

    const result = await groundAircraftWithDb(db, sess, { resourceId: aircraftId, reason: 'Second ground' });

    expect(result.ok).toBe(true);
    expect(result.alreadyGrounded).toBe(true);
    expect(result.grounding.state).toBe('grounded');

    // No new event row.
    const eventsAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(aircraftGrounding).where(eq(aircraftGrounding.resourceId, aircraftId)).execute(),
    );
    expect(eventsAfter.length).toBe(eventsBefore.length);

    // No new audit row.
    const auditsAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityType, 'aircraft_grounding')).execute(),
    );
    expect(auditsAfter.length).toBe(auditsBefore.length);
  });

  it('double-release: second unGroundAircraft on not-grounded → alreadyReleased:true, NO new event, NO audit', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'IDMP2');
    // Not grounded yet — unGround should be a no-op.
    const auditsBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'grounding.released')).execute(),
    );

    const result = await unGroundAircraftWithDb(db, sess, { resourceId: aircraftId });

    expect(result.ok).toBe(true);
    expect(result.alreadyReleased).toBe(true);
    expect(result.grounding).toBeNull();

    const auditsAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'grounding.released')).execute(),
    );
    expect(auditsAfter.length).toBe(auditsBefore.length);
  });

  it('ground → unground → unground again → alreadyReleased:true, no new event', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'IDMP3');
    await groundAircraftWithDb(db, sess, { resourceId: aircraftId, reason: 'test' });
    await unGroundAircraftWithDb(db, sess, { resourceId: aircraftId });

    const eventsBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(aircraftGrounding).where(eq(aircraftGrounding.resourceId, aircraftId)).execute(),
    );

    const result = await unGroundAircraftWithDb(db, sess, { resourceId: aircraftId });
    expect(result.ok).toBe(true);
    expect(result.alreadyReleased).toBe(true);

    const eventsAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(aircraftGrounding).where(eq(aircraftGrounding.resourceId, aircraftId)).execute(),
    );
    expect(eventsAfter.length).toBe(eventsBefore.length);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 7 — getGroundingStatus: latest-per-resource + tie-break + RLS
// ════════════════════════════════════════════════════════════════════════════════

describe('getGroundingStatus: multi-resource, latest-event, RLS', () => {
  it('absent resource id → grounded:false (no events)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const status = await getGroundingStatusWithDb(db, sess, {
      resourceIds: ['00000000-0000-0000-0000-000000000099'],
    });
    const entry = status.get('00000000-0000-0000-0000-000000000099');
    expect(entry).toBeDefined();
    expect(entry?.grounded).toBe(false);
    expect(entry?.reason).toBeNull();
    expect(entry?.eventId).toBeNull();
  });

  it('multiple resources: mix of grounded/not-grounded keyed correctly', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const ac1 = await seedAircraft(db, orgAId, userAId, 'MULTI1');
    const ac2 = await seedAircraft(db, orgAId, userAId, 'MULTI2');

    await groundAircraftWithDb(db, sess, { resourceId: ac1, reason: 'Down for mx' });
    // ac2 never grounded.

    const status = await getGroundingStatusWithDb(db, sess, { resourceIds: [ac1, ac2] });

    expect(status.get(ac1)?.grounded).toBe(true);
    expect(status.get(ac1)?.reason).toBe('Down for mx');
    expect(status.get(ac2)?.grounded).toBe(false);
  });

  it('RLS: cross-org aircraft shows grounded:false from other org session', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;

    // Ground an aircraft in org B.
    const sessB = makeSession(orgBId, userBId, 'owner');
    const acB = await seedAircraft(db, orgBId, userBId, 'RLSGND');
    await groundAircraftWithDb(db, sessB, { resourceId: acB, reason: 'Cross-org test' });

    // Query from org A — should see grounded:false (RLS blocks orgB event).
    const sessA = makeSession(orgAId, userAId, 'owner');
    const status = await getGroundingStatusWithDb(db, sessA, { resourceIds: [acB] });
    expect(status.get(acB)?.grounded).toBe(false);
  });

  it('latest event wins: ground → release → ground → status is grounded', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const acId = await seedAircraft(db, orgAId, userAId, 'LATEST1');
    await groundAircraftWithDb(db, sess, { resourceId: acId, reason: 'First ground' });
    await unGroundAircraftWithDb(db, sess, { resourceId: acId });
    await groundAircraftWithDb(db, sess, { resourceId: acId, reason: 'Second ground' });

    const status = await getGroundingStatusWithDb(db, sess, { resourceIds: [acId] });
    expect(status.get(acId)?.grounded).toBe(true);
    expect(status.get(acId)?.reason).toBe('Second ground');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 8 — openDispatch GROUNDED BLOCK
// ════════════════════════════════════════════════════════════════════════════════

describe('openDispatch GROUNDED BLOCK: grounding blocks dispatch', () => {
  it('grounded aircraft → {ok:false, reason:grounded} — no write, no audit', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const { aircraftId, reservationId } = await seedReservationWithAircraft(
      db, orgAId, userAId, 'DSPGND1',
    );

    // Ground the aircraft first.
    await groundAircraftWithDb(db, sess, { resourceId: aircraftId, reason: 'AOG' });

    const auditBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(eq(auditLog.entityType, 'dispatch_ticket'))
        .execute(),
    );

    const result = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 100,
      tachOut: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.reason).toBe('grounded');
    if (result.reason !== 'grounded') throw new Error('expected grounded');
    expect(result.grounding.resourceId).toBe(aircraftId);
    expect(result.grounding.reason).toBe('AOG');

    // No dispatch audit rows written.
    const auditAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(eq(auditLog.entityType, 'dispatch_ticket'))
        .execute(),
    );
    expect(auditAfter.length).toBe(auditBefore.length);
  });

  it('after release: openDispatch succeeds', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const { aircraftId, reservationId } = await seedReservationWithAircraft(
      db, orgAId, userAId, 'DSPGND2', T.W2_start, T.W2_end,
    );

    // Ground then release.
    await groundAircraftWithDb(db, sess, { resourceId: aircraftId, reason: 'Temp grounded' });
    await unGroundAircraftWithDb(db, sess, { resourceId: aircraftId });

    const result = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 200,
      tachOut: 200,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.ticket.status).toBe('open');
    expect(result.ticket.resourceId).toBe(aircraftId);
  });

  it('not-grounded aircraft: openDispatch proceeds normally (no grounded arm)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const { aircraftId, reservationId } = await seedReservationWithAircraft(
      db, orgAId, userAId, 'DSPNOGND',
    );

    const result = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 50,
      tachOut: 50,
    });

    expect(result.ok).toBe(true);
    // The ok:true arm has no 'reason' property (it's the ticket arm).
    expect('reason' in result).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 9 — HAPPY PATH: reportSquawk
// ════════════════════════════════════════════════════════════════════════════════

describe('HAPPY PATH: reportSquawk', () => {
  it('reports a squawk → ok:true, status=open, audit row written', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'SQ1');

    const auditBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityType, 'squawk')).execute(),
    );

    const result = await reportSquawkWithDb(db, sess, {
      resourceId: aircraftId,
      title: 'Cracked windshield',
      description: 'Spider crack lower left',
      severity: 'medium',
    });

    expect(result.ok).toBe(true);
    const sq = result.squawk;
    expect(sq.status).toBe('open');
    expect(sq.resourceId).toBe(aircraftId);
    expect(sq.title).toBe('Cracked windshield');
    expect(sq.description).toBe('Spider crack lower left');
    expect(sq.severity).toBe('medium');
    expect(sq.reportedBy).toBe(userAId);
    expect(sq.reportedAt).toBeInstanceOf(Date);
    expect(sq.resolutionNotes).toBeNull();
    expect(sq.resolvedBy).toBeNull();
    expect(sq.resolvedAt).toBeNull();

    const auditAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityType, 'squawk')).execute(),
    );
    expect(auditAfter.length - auditBefore.length).toBe(1);
    const auditRow = auditAfter[auditAfter.length - 1]!;
    expect(auditRow.action).toBe('squawk.reported');
    expect(auditRow.entityId).toBe(sq.id);
    const meta = auditRow.metadata as Record<string, unknown>;
    expect(meta['severity']).toBe('medium');
  });

  it('severity=grounding does NOT create an aircraft_grounding event', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'SQ2');

    const groundingEventsBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(aircraftGrounding)
        .where(eq(aircraftGrounding.resourceId, aircraftId))
        .execute(),
    );

    const result = await reportSquawkWithDb(db, sess, {
      resourceId: aircraftId,
      title: 'Major oil leak',
      severity: 'grounding',
    });

    expect(result.ok).toBe(true);
    expect(result.squawk.severity).toBe('grounding');

    // NO aircraft_grounding event written — severity is advisory only.
    const groundingEventsAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(aircraftGrounding)
        .where(eq(aircraftGrounding.resourceId, aircraftId))
        .execute(),
    );
    expect(groundingEventsAfter.length).toBe(groundingEventsBefore.length);

    // Aircraft is still not grounded.
    const status = await getGroundingStatusWithDb(db, sess, { resourceIds: [aircraftId] });
    expect(status.get(aircraftId)?.grounded).toBe(false);
  });

  it('reportSquawk with dispatchTicketId → squawk links to ticket', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const { aircraftId, reservationId } = await seedReservationWithAircraft(
      db, orgAId, userAId, 'SQTKT',
    );

    const openResult = await openDispatchWithDb(db, sess, {
      reservationId,
      resourceId: aircraftId,
      pilotUserId: userAId,
      hobbsOut: 100,
      tachOut: 100,
    });
    expect(openResult.ok).toBe(true);
    if (!openResult.ok) return;

    const result = await reportSquawkWithDb(db, sess, {
      resourceId: aircraftId,
      title: 'Wobbly throttle',
      severity: 'high',
      dispatchTicketId: openResult.ticket.id,
    });

    expect(result.ok).toBe(true);
    expect(result.squawk.dispatchTicketId).toBe(openResult.ticket.id);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 10 — updateSquawkStatus
// ════════════════════════════════════════════════════════════════════════════════

describe('updateSquawkStatus: transitions + edge cases', () => {
  it('open→resolved happy path + audit', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'UPD1');
    const reportResult = await reportSquawkWithDb(db, sess, {
      resourceId: aircraftId,
      title: 'Fuel cap missing',
      severity: 'high',
    });
    expect(reportResult.ok).toBe(true);
    const squawkId = reportResult.squawk.id;

    const auditBefore = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(eq(auditLog.entityType, 'squawk'), eq(auditLog.entityId, squawkId)))
        .execute(),
    );

    const result = await updateSquawkStatusWithDb(db, sess, {
      squawkId,
      status: 'resolved',
      resolutionNotes: 'Replaced cap',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const sq = result.squawk;
    expect(sq.status).toBe('resolved');
    expect(sq.resolutionNotes).toBe('Replaced cap');
    expect(sq.resolvedBy).toBe(userAId);
    expect(sq.resolvedAt).toBeInstanceOf(Date);

    const auditAfter = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(eq(auditLog.entityType, 'squawk'), eq(auditLog.entityId, squawkId)))
        .execute(),
    );
    expect(auditAfter.length - auditBefore.length).toBe(1);
    const statusAudit = auditAfter.find((r) => r.action === 'squawk.status_changed');
    expect(statusAudit).toBeDefined();
    const meta = statusAudit!.metadata as Record<string, unknown>;
    expect(meta['newStatus']).toBe('resolved');
    expect(meta['resolutionNotes']).toBe('Replaced cap');
  });

  it('open→deferred happy path', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'UPD2');
    const reportResult = await reportSquawkWithDb(db, sess, {
      resourceId: aircraftId,
      title: 'Worn seat cushion',
      severity: 'low',
    });
    expect(reportResult.ok).toBe(true);
    const squawkId = reportResult.squawk.id;

    const result = await updateSquawkStatusWithDb(db, sess, {
      squawkId,
      status: 'deferred',
      resolutionNotes: 'Deferred until next 100hr',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.squawk.status).toBe('deferred');
    expect(result.squawk.resolutionNotes).toBe('Deferred until next 100hr');
  });

  it('re-resolve already-resolved squawk → not_open', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'UPD3');
    const reportResult = await reportSquawkWithDb(db, sess, {
      resourceId: aircraftId,
      title: 'Landing light out',
      severity: 'medium',
    });
    expect(reportResult.ok).toBe(true);
    const squawkId = reportResult.squawk.id;

    // First resolve.
    await updateSquawkStatusWithDb(db, sess, { squawkId, status: 'resolved' });

    // Second resolve → not_open.
    const result = await updateSquawkStatusWithDb(db, sess, { squawkId, status: 'resolved' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.reason).toBe('not_open');
  });

  it('cross-org squawk → not_found', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;

    // Create a squawk in org B.
    const sessB = makeSession(orgBId, userBId, 'owner');
    const acB = await seedAircraft(db, orgBId, userBId, 'CROSS2');
    const reportB = await reportSquawkWithDb(db, sessB, {
      resourceId: acB,
      title: 'Cross-org squawk',
      severity: 'low',
    });
    expect(reportB.ok).toBe(true);

    // Try to resolve from org A.
    const sessA = makeSession(orgAId, userAId, 'owner');
    const result = await updateSquawkStatusWithDb(db, sessA, {
      squawkId: reportB.squawk.id,
      status: 'resolved',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.reason).toBe('not_found');
  });

  it('unknown squawkId → not_found', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const result = await updateSquawkStatusWithDb(db, sess, {
      squawkId: '00000000-0000-0000-0000-000000000099',
      status: 'resolved',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected not ok');
    expect(result.reason).toBe('not_found');
  });

  it('concurrency guard: WHERE status=open prevents double-resolve', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'CONC1');
    const reportResult = await reportSquawkWithDb(db, sess, {
      resourceId: aircraftId,
      title: 'Static wick missing',
      severity: 'low',
    });
    expect(reportResult.ok).toBe(true);
    const squawkId = reportResult.squawk.id;

    // First close wins.
    const first = await updateSquawkStatusWithDb(db, sess, { squawkId, status: 'resolved' });
    expect(first.ok).toBe(true);

    // Second attempt: WHERE status='open' finds 0 rows → not_open.
    const second = await updateSquawkStatusWithDb(db, sess, { squawkId, status: 'deferred' });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected not ok');
    expect(second.reason).toBe('not_open');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 11 — listSquawks
// ════════════════════════════════════════════════════════════════════════════════

describe('listSquawks: filters + ordering', () => {
  it('no-filter list returns squawks newest-first', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'LIST1');

    await reportSquawkWithDb(db, sess, { resourceId: aircraftId, title: 'Older squawk', severity: 'low' });
    await reportSquawkWithDb(db, sess, { resourceId: aircraftId, title: 'Newer squawk', severity: 'high' });

    const squawks = await listSquawksWithDb(db, sess, { resourceId: aircraftId });

    expect(squawks.length).toBeGreaterThanOrEqual(2);
    // Newest first: the last-reported should appear first.
    const idx1 = squawks.findIndex((s) => s.title === 'Newer squawk');
    const idx2 = squawks.findIndex((s) => s.title === 'Older squawk');
    expect(idx1).toBeLessThan(idx2);
  });

  it('filter by resourceId returns only squawks for that aircraft', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const ac1 = await seedAircraft(db, orgAId, userAId, 'LIST2');
    const ac2 = await seedAircraft(db, orgAId, userAId, 'LIST3');

    await reportSquawkWithDb(db, sess, { resourceId: ac1, title: 'Squawk on AC1', severity: 'low' });
    await reportSquawkWithDb(db, sess, { resourceId: ac2, title: 'Squawk on AC2', severity: 'low' });

    const squawks = await listSquawksWithDb(db, sess, { resourceId: ac1 });
    expect(squawks.every((s) => s.resourceId === ac1)).toBe(true);
  });

  it('filter by status=open returns only open squawks', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const ac = await seedAircraft(db, orgAId, userAId, 'LIST4');

    const r1 = await reportSquawkWithDb(db, sess, { resourceId: ac, title: 'Open squawk', severity: 'low' });
    const r2 = await reportSquawkWithDb(db, sess, { resourceId: ac, title: 'Resolved squawk', severity: 'low' });
    expect(r1.ok && r2.ok).toBe(true);

    await updateSquawkStatusWithDb(db, sess, { squawkId: r2.squawk.id, status: 'resolved' });

    const squawks = await listSquawksWithDb(db, sess, { resourceId: ac, status: 'open' });
    expect(squawks.every((s) => s.status === 'open')).toBe(true);
    expect(squawks.some((s) => s.id === r1.squawk.id)).toBe(true);
    expect(squawks.some((s) => s.id === r2.squawk.id)).toBe(false);
  });

  it('limit caps results', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const squawks = await listSquawksWithDb(db, sess, { limit: 1 });
    expect(squawks.length).toBeLessThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 12 — getOpenSquawkCounts
// ════════════════════════════════════════════════════════════════════════════════

describe('getOpenSquawkCounts: counts + 0 default', () => {
  it('aircraft with no open squawks → 0 count', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const ac = await seedAircraft(db, orgAId, userAId, 'CNT0');
    const counts = await getOpenSquawkCountsWithDb(db, sess, { resourceIds: [ac] });

    expect(counts.get(ac)).toBe(0);
  });

  it('aircraft with open squawks → correct count', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const ac = await seedAircraft(db, orgAId, userAId, 'CNT2');

    await reportSquawkWithDb(db, sess, { resourceId: ac, title: 'Sq1', severity: 'low' });
    await reportSquawkWithDb(db, sess, { resourceId: ac, title: 'Sq2', severity: 'medium' });

    const counts = await getOpenSquawkCountsWithDb(db, sess, { resourceIds: [ac] });
    expect(counts.get(ac)).toBeGreaterThanOrEqual(2);
  });

  it('resolved squawk not counted as open', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const ac = await seedAircraft(db, orgAId, userAId, 'CNT3');

    const r = await reportSquawkWithDb(db, sess, { resourceId: ac, title: 'Will resolve', severity: 'low' });
    expect(r.ok).toBe(true);
    await updateSquawkStatusWithDb(db, sess, { squawkId: r.squawk.id, status: 'resolved' });

    const counts = await getOpenSquawkCountsWithDb(db, sess, { resourceIds: [ac] });
    expect(counts.get(ac)).toBe(0);
  });

  it('multi-resource counts returned correctly with 0 defaults', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const ac1 = await seedAircraft(db, orgAId, userAId, 'CNTM1');
    const ac2 = await seedAircraft(db, orgAId, userAId, 'CNTM2');

    await reportSquawkWithDb(db, sess, { resourceId: ac1, title: 'SqA', severity: 'low' });
    // ac2 has no squawks.

    const counts = await getOpenSquawkCountsWithDb(db, sess, { resourceIds: [ac1, ac2] });

    expect(counts.get(ac1)).toBeGreaterThanOrEqual(1);
    expect(counts.get(ac2)).toBe(0);
    expect(counts.size).toBe(2);
  });

  it('cross-org aircraft → 0 (RLS blocks)', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = sharedEnv;

    const sessB = makeSession(orgBId, userBId, 'owner');
    const acB = await seedAircraft(db, orgBId, userBId, 'CNTCROSS');
    await reportSquawkWithDb(db, sessB, { resourceId: acB, title: 'Cross-org sq', severity: 'low' });

    const sessA = makeSession(orgAId, userAId, 'owner');
    const counts = await getOpenSquawkCountsWithDb(db, sessA, { resourceIds: [acB] });
    expect(counts.get(acB)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 13 — AUDIT INVARIANTS
// ════════════════════════════════════════════════════════════════════════════════

describe('AUDIT INVARIANTS', () => {
  it('idempotent groundAircraft (already-grounded) writes zero audit rows', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const ac = await seedAircraft(db, orgAId, userAId, 'AUDINOP1');
    await groundAircraftWithDb(db, sess, { resourceId: ac, reason: 'Initial ground' });

    const before = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(eq(auditLog.entityType, 'aircraft_grounding'), eq(auditLog.action, 'grounding.grounded')))
        .execute(),
    );

    // Idempotent call.
    await groundAircraftWithDb(db, sess, { resourceId: ac, reason: 'Again' });

    const after = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(and(eq(auditLog.entityType, 'aircraft_grounding'), eq(auditLog.action, 'grounding.grounded')))
        .execute(),
    );
    expect(after.length).toBe(before.length);
  });

  it('refused updateSquawkStatus (not_found) writes zero audit rows', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const before = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(eq(auditLog.action, 'squawk.status_changed'))
        .execute(),
    );

    await updateSquawkStatusWithDb(db, sess, {
      squawkId: '00000000-0000-0000-0000-000000009999',
      status: 'resolved',
    }); // returns not_found

    const after = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog)
        .where(eq(auditLog.action, 'squawk.status_changed'))
        .execute(),
    );
    expect(after.length).toBe(before.length);
  });

  it('exactly one audit row per reportSquawk call', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const ac = await seedAircraft(db, orgAId, userAId, 'AUDSQ1');

    const before = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'squawk.reported')).execute(),
    );

    await reportSquawkWithDb(db, sess, { resourceId: ac, title: 'Audit test', severity: 'low' });

    const after = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'squawk.reported')).execute(),
    );
    expect(after.length - before.length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 14 — GROUNDING GATE AT CREATE (Wave 3b / ADR-0008 §2.3 Option A)
//
// WARN-ONLY at create: a grounded aircraft does NOT block the create; the warning
// rides along on the ok:true result as `groundingWarnings`. Refusal arms
// (conflict / policy / conflict_and_policy) are byte-identical — grounding is
// evaluated ONLY on the success path, so a refused create never carries it.
// ════════════════════════════════════════════════════════════════════════════════

describe('GROUNDING GATE AT CREATE: warn-only via gatedCreateOccurrence', () => {
  // `now` anchored before the future reservation windows so booking-policy lead
  // time / advance checks pass deterministically.
  const NOW = new Date('2026-08-01T00:00:00Z').getTime();

  it('create on a GROUNDED aircraft → ok:true WITH groundingWarnings (does NOT block)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'GATEGND1');
    await groundAircraftWithDb(db, sess, { resourceId: aircraftId, reason: 'Annual inspection' });

    const result = await createReservationWithDb(
      db,
      sess,
      { startAt: T.W1_start, endAt: T.W1_end, resourceIds: [aircraftId] },
      { now: NOW },
    );

    // The create SUCCEEDS — warn, not block.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.groundingWarnings).toBeDefined();
    expect(result.groundingWarnings).toHaveLength(1);
    expect(result.groundingWarnings![0]).toEqual({
      resourceId: aircraftId,
      reason: 'Annual inspection',
    });

    // A reservation row was actually written (the create is real, not refused).
    const resv = await withOrgContext(db, orgAId, (tx) =>
      tx.execute(sql`SELECT id FROM reservation WHERE id = ${result.reservation.id}::uuid`),
    );
    const resvRows = (resv as { rows?: unknown[] }).rows ?? (resv as unknown as unknown[]);
    expect(resvRows.length).toBe(1);
  });

  it('create on a NEVER-grounded aircraft → ok:true, groundingWarnings ABSENT', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'GATENG1');

    const result = await createReservationWithDb(
      db,
      sess,
      { startAt: T.W2_start, endAt: T.W2_end, resourceIds: [aircraftId] },
      { now: NOW },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    // Field is absent (byte-identical ok:true shape when nothing grounded).
    expect(result.groundingWarnings).toBeUndefined();
    expect('groundingWarnings' in result).toBe(false);
  });

  it('create on a released (grounded-then-released) aircraft → ok:true, no warnings', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'GATEREL1');
    await groundAircraftWithDb(db, sess, { resourceId: aircraftId, reason: 'Temp' });
    await unGroundAircraftWithDb(db, sess, { resourceId: aircraftId });

    const result = await createReservationWithDb(
      db,
      sess,
      { startAt: new Date('2026-08-20T08:00:00Z'), endAt: new Date('2026-08-20T10:00:00Z'), resourceIds: [aircraftId] },
      { now: NOW },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.groundingWarnings).toBeUndefined();
  });

  it('a GROUNDED instructor-kind resource is never warned (only aircraft evaluated)', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // A bookable aircraft + a bookable instructor.
    const aircraftId = await seedAircraft(db, orgAId, userAId, 'GATEINST1');
    const instructor = await createResourceWithDb(db, sess, {
      kind: 'instructor',
      displayName: 'CFI Gate',
      instructorUserId: userAId,
    });

    // Contrive a 'grounded' aircraft_grounding event for the INSTRUCTOR resource
    // (groundAircraft itself rejects non-aircraft; we insert directly to prove
    // the gate filters by resource KIND, not merely by the probe's grounded flag).
    await withOrgContext(db, orgAId, (tx) =>
      tx.execute(sql`
        INSERT INTO aircraft_grounding (org_id, resource_id, state, reason, created_by)
        VALUES (${orgAId}::uuid, ${instructor.id}::uuid, 'grounded', 'contrived', ${userAId}::uuid)
      `),
    );

    const result = await createReservationWithDb(
      db,
      sess,
      {
        startAt: new Date('2026-08-21T08:00:00Z'),
        endAt: new Date('2026-08-21T10:00:00Z'),
        resourceIds: [aircraftId, instructor.id],
      },
      { now: NOW },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    // Aircraft is NOT grounded → no warnings; the grounded instructor is ignored.
    expect(result.groundingWarnings).toBeUndefined();
  });

  it('grounded aircraft that ALSO conflicts → reason:conflict, NO groundingWarnings', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'GATECONF1');
    await groundAircraftWithDb(db, sess, { resourceId: aircraftId, reason: 'Grounded + busy' });

    // First booking occupies the window.
    const first = await createReservationWithDb(
      db,
      sess,
      { startAt: new Date('2026-08-22T08:00:00Z'), endAt: new Date('2026-08-22T10:00:00Z'), resourceIds: [aircraftId] },
      { now: NOW },
    );
    expect(first.ok).toBe(true);

    // Overlapping booking on the same grounded aircraft → conflict refusal.
    const second = await createReservationWithDb(
      db,
      sess,
      { startAt: new Date('2026-08-22T09:00:00Z'), endAt: new Date('2026-08-22T11:00:00Z'), resourceIds: [aircraftId] },
      { now: NOW },
    );

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected refusal');
    expect(second.reason).toBe('conflict');
    // Refusal arm is byte-identical — grounding is NOT evaluated on a refusal.
    expect('groundingWarnings' in second).toBe(false);
  });

  it('warn flows through createSeries: each created occurrence on a grounded aircraft carries the warning', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    const aircraftId = await seedAircraft(db, orgAId, userAId, 'GATESER1');
    await groundAircraftWithDb(db, sess, { resourceId: aircraftId, reason: 'Series ground' });

    // Anchor to a Monday 00:00 UTC (mirrors recurrence-api's BASE_NOW) so the
    // weekly expansion deterministically yields future occurrences.
    const MONDAY_NOW = Date.UTC(2026, 0, 5); // 2026-01-05T00:00:00Z (Monday)
    const result = await createSeriesWithDb(
      db,
      sess,
      {
        weekdays: [1], // Monday
        intervalWeeks: 1,
        end: { kind: 'count', count: 2 },
        localStartTime: '10:00',
        durationMinutes: 60,
        tz: 'UTC',
        resourceIds: [aircraftId],
      },
      { now: MONDAY_NOW },
    );

    expect(result.ok).toBe(true);
    if (result.createdCount === 0) {
      throw new Error(
        `series created 0 occurrences; skips: ${JSON.stringify(
          result.occurrences.map((o) => ({ result: o.result, reason: o.reason })),
        )}`,
      );
    }
    expect(result.createdCount).toBeGreaterThan(0);
    const created = result.occurrences.filter((o) => o.result === 'created');
    expect(created.length).toBe(result.createdCount);
    for (const occ of created) {
      expect(occ.groundingWarnings).toBeDefined();
      expect(occ.groundingWarnings).toHaveLength(1);
      expect(occ.groundingWarnings![0]).toEqual({ resourceId: aircraftId, reason: 'Series ground' });
    }
  });

  it('warn flows through rescheduleReservation onto a grounded aircraft', async () => {
    const { db, orgAId, userAId } = sharedEnv;
    const sess = makeSession(orgAId, userAId, 'owner');

    // Book on a clean aircraft, then ground it, then reschedule to a new window.
    const aircraftId = await seedAircraft(db, orgAId, userAId, 'GATERES1');
    const created = await createReservationWithDb(
      db,
      sess,
      { startAt: new Date('2026-08-23T08:00:00Z'), endAt: new Date('2026-08-23T10:00:00Z'), resourceIds: [aircraftId] },
      { now: NOW },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected ok');
    // No warning at the clean create.
    expect(created.groundingWarnings).toBeUndefined();

    await groundAircraftWithDb(db, sess, { resourceId: aircraftId, reason: 'Grounded mid-life' });

    const moved = await rescheduleReservationWithDb(
      db,
      sess,
      {
        reservationId: created.reservation.id,
        newStartAt: new Date('2026-08-23T12:00:00Z'),
        newEndAt: new Date('2026-08-23T14:00:00Z'),
      },
      { now: NOW },
    );

    expect(moved.ok).toBe(true);
    if (!moved.ok) throw new Error('expected ok');
    expect(moved.groundingWarnings).toBeDefined();
    expect(moved.groundingWarnings).toHaveLength(1);
    expect(moved.groundingWarnings![0]).toEqual({ resourceId: aircraftId, reason: 'Grounded mid-life' });
  });
});
