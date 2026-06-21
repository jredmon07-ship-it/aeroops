/**
 * dispatch-correction-schema.test.ts — Schema tests for 0018_dispatch_ticket_correction.sql
 *                                      (Slice B0 / ADR-0007 §1)
 *
 * Proves that (spec Slice B0 acceptance criteria):
 *
 *   DC1.  Table exists after migration 0018.
 *   DC2.  FORCE RLS fail-closed: GUC unset → 0 rows from dispatch_ticket_correction.
 *   DC3.  RLS isolation: org A cannot see org B's correction rows (cross-org SELECT → 0).
 *   DC4.  APPEND-ONLY (headline records-integrity guarantee):
 *         DC4a. UPDATE a correction row as aeroops_app → REJECTED (no UPDATE policy
 *               + REVOKE UPDATE; mirrors audit_log T14 pattern exactly).
 *         DC4b. DELETE a correction row as aeroops_app → REJECTED (no DELETE policy
 *               + REVOKE DELETE; mirrors audit_log T14 pattern exactly).
 *         DC4c. Row is untouched after rejected UPDATE (verify original data).
 *         DC4d. Row still exists after rejected DELETE (verify via superuser).
 *   DC5.  Composite FK cross-org rejection:
 *         DC5a. dispatch_ticket_id belonging to org B (with org_id of org A) → FK violation.
 *         DC5b. created_by from org B (with org_id of org A) → FK violation.
 *   DC6.  RESTRICT FK integrity:
 *         DC6a. Hard-deleting a dispatch_ticket that has a correction → REJECTED (RESTRICT).
 *         DC6b. Hard-deleting an app_user (created_by) that has a correction → REJECTED (RESTRICT).
 *   DC7.  CHECKs fire:
 *         DC7a. correction_at_least_one_meter_check: both meters NULL → rejected.
 *         DC7b. correction_hobbs_nonneg_check: negative corrected_hobbs → rejected.
 *         DC7c. correction_tach_nonneg_check: negative corrected_tach → rejected.
 *         DC7d. correction_reason_nonempty_check: empty reason → rejected.
 *         DC7e. correction_reason_nonempty_check: blank/whitespace reason → rejected.
 *         DC7f. hobbs-only correction (tach NULL) → accepted.
 *         DC7g. tach-only correction (hobbs NULL) → accepted.
 *   DC8.  UNIQUE(id, org_id) composite candidate key index exists.
 *   DC9.  Happy-path round-trips:
 *         DC9a. Single correction for a seeded dispatch_ticket round-trips.
 *         DC9b. Multiple corrections for the same ticket coexist (append-only; latest wins).
 *         DC9c. "ORDER BY created_at DESC LIMIT 1" returns the latest correction.
 *         DC9d. correction_org_ticket_created_idx index exists (effective-meter query pattern).
 *   DC10. Down migration reverses 0018: table + policies gone after down.
 *
 * FK chain seeded (mirrors dispatch-schema.test.ts):
 *   org → app_user → resource → reservation → dispatch_ticket → dispatch_ticket_correction
 *
 * Append-only assertion pattern mirrors T14 (audit_log) in rls-isolation.test.ts.
 *
 * Test harness: PGlite (in-process Postgres WASM). Applies migrations 0000–0018
 * in order so constraint SQL validated here is the exact production artifact.
 * NEVER applied to a real DB.
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
  withPlatformAdminContext,
} from '../index.js';
import { org, appUser, resource, reservation, dispatchTicket, dispatchTicketCorrection } from '../schema/index.js';
import type { PgliteTestClient } from '../client.js';

// ── Path resolution ───────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_SQL = [
  readFileSync(resolve(__dirname, '../../migrations/0000_loud_prodigy.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0001_auth_credential.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0002_scheduling.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0003_booking_policies.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0004_recurrence.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0005_dispatch.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0006_squawks_grounding.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0007_fleet.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0008_people.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0009_dispatch_gate.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0010_civil_twilight.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0011_optimizer_run.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0012_training.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0013_work_orders.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0014_availability.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0015_booking_request.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0016_booking_request_convert.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0017_booking_retention.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0018_dispatch_ticket_correction.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0019_billing_records.sql'), 'utf-8'),
];

const DOWN_0018 = readFileSync(
  resolve(__dirname, '../../migrations/0018_dispatch_ticket_correction.down.sql'),
  'utf-8',
);

// ── Test environment ──────────────────────────────────────────────────────────

interface CorrectionTestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;           // member of org A — correction author + FK target
  userBId: string;           // member of org B — cross-org rejection tests
  aircraftAId: string;       // resource (kind='aircraft') in org A
  aircraftBId: string;       // resource (kind='aircraft') in org B
  reservationAId: string;    // booked reservation in org A
  reservationBId: string;    // booked reservation in org B
  closedTicketAId: string;   // closed dispatch_ticket in org A (primary correction target)
  closedTicketBId: string;   // closed dispatch_ticket in org B (cross-org rejection tests)
}

/**
 * Insert a closed dispatch_ticket row. Requires superuser context (pre-setTestAppRole).
 * Mirrors insertClosedTicket in dispatch-schema.test.ts.
 */
async function insertClosedTicket(
  pglite: PGlite,
  orgId: string,
  reservationId: string,
  resourceId: string,
  pilotUserId: string,
  openedBy: string,
  closedBy: string,
): Promise<string> {
  const result = await pglite.query<{ id: string }>(
    `INSERT INTO dispatch_ticket (
       org_id, reservation_id, resource_id, pilot_user_id,
       status, hobbs_out, tach_out,
       hobbs_in, tach_in, flight_time_hours,
       opened_by, closed_by, closed_at
     ) VALUES (
       $1, $2, $3, $4,
       'closed', 100.0, 95.5,
       101.1, 96.6, 1.1,
       $5, $6, now()
     ) RETURNING id`,
    [orgId, reservationId, resourceId, pilotUserId, openedBy, closedBy],
  );
  return result.rows[0]!.id;
}

/**
 * Insert a valid correction row via raw SQL (GUC must be set by caller).
 * Returns the new correction id.
 */
async function insertCorrection(
  pglite: PGlite,
  orgId: string,
  dispatchTicketId: string,
  createdBy: string,
  opts: {
    correctedHobbs?: number | null;
    correctedTach?: number | null;
    reason?: string;
  } = {},
): Promise<string> {
  const correctedHobbs = opts.correctedHobbs !== undefined ? opts.correctedHobbs : 102.2;
  const correctedTach = opts.correctedTach !== undefined ? opts.correctedTach : 97.7;
  const reason = opts.reason ?? 'Hobbs counter jumped at shutdown — mechanic verified.';

  const result = await pglite.query<{ id: string }>(
    `INSERT INTO dispatch_ticket_correction
       (org_id, dispatch_ticket_id, corrected_hobbs, corrected_tach, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [orgId, dispatchTicketId, correctedHobbs, correctedTach, reason, createdBy],
  );
  return result.rows[0]!.id;
}

async function setupCorrectionEnv(): Promise<CorrectionTestEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  // Seed orgs as platform admin (superuser context).
  const [orgA, orgB] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx
      .insert(org)
      .values({ name: 'Alpha Flight School', slug: 'alpha-correction' })
      .returning();
    const b = await tx
      .insert(org)
      .values({ name: 'Beta FBO', slug: 'beta-correction' })
      .returning();
    return [a[0]!, b[0]!];
  });

  // Org A: user + aircraft + reservation.
  const [userA, aircraftA, reservationA] = await withOrgContext(db, orgA.id, async (tx) => {
    const u = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'alice@alpha-corr.example', fullName: 'Alice Correction' })
      .returning();
    const r = await tx
      .insert(resource)
      .values({
        orgId: orgA.id,
        kind: 'aircraft',
        displayName: 'Cessna 172 N11111',
        tailNumber: 'N11111',
      })
      .returning();
    const res = await tx
      .insert(reservation)
      .values({
        orgId: orgA.id,
        startAt: new Date('2026-08-01T10:00:00Z'),
        endAt: new Date('2026-08-01T12:00:00Z'),
        status: 'booked',
        createdBy: u[0]!.id,
      })
      .returning();
    return [u[0]!, r[0]!, res[0]!];
  });

  // Org B: user + aircraft + reservation.
  const [userB, aircraftB, reservationB] = await withOrgContext(db, orgB.id, async (tx) => {
    const u = await tx
      .insert(appUser)
      .values({ orgId: orgB.id, email: 'bob@beta-corr.example', fullName: 'Bob Correction' })
      .returning();
    const r = await tx
      .insert(resource)
      .values({
        orgId: orgB.id,
        kind: 'aircraft',
        displayName: 'Piper PA-28 N22222',
        tailNumber: 'N22222',
      })
      .returning();
    const res = await tx
      .insert(reservation)
      .values({
        orgId: orgB.id,
        startAt: new Date('2026-08-01T10:00:00Z'),
        endAt: new Date('2026-08-01T12:00:00Z'),
        status: 'booked',
        createdBy: u[0]!.id,
      })
      .returning();
    return [u[0]!, r[0]!, res[0]!];
  });

  // Seed a closed dispatch_ticket for each org (superuser, no FORCE RLS).
  await pglite.exec(`SET ROLE postgres`);
  await pglite.exec(`BEGIN`);
  await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgA.id}'`);
  const closedTicketAId = await insertClosedTicket(
    pglite, orgA.id, reservationA.id, aircraftA.id, userA.id, userA.id, userA.id,
  );
  await pglite.exec(`COMMIT`);

  await pglite.exec(`BEGIN`);
  await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgB.id}'`);
  const closedTicketBId = await insertClosedTicket(
    pglite, orgB.id, reservationB.id, aircraftB.id, userB.id, userB.id, userB.id,
  );
  await pglite.exec(`COMMIT`);

  // Drop to aeroops_app for RLS enforcement on all subsequent queries.
  await setTestAppRole({ pglite });

  return {
    db,
    pglite,
    orgAId: orgA.id,
    orgBId: orgB.id,
    userAId: userA.id,
    userBId: userB.id,
    aircraftAId: aircraftA.id,
    aircraftBId: aircraftB.id,
    reservationAId: reservationA.id,
    reservationBId: reservationB.id,
    closedTicketAId,
    closedTicketBId,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('dispatch-correction-schema: migration 0018 + constraints + RLS + append-only', () => {
  let env: CorrectionTestEnv;

  beforeAll(async () => {
    env = await setupCorrectionEnv();
  });

  // ── DC1: Table exists ───────────────────────────────────────────────────────

  it('DC1: dispatch_ticket_correction table exists after migration 0018', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_ticket_correction'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  // ── DC2: FORCE RLS fail-closed (GUC unset → 0 rows) ────────────────────────

  it('DC2: FORCE RLS fail-closed — GUC unset → 0 rows from dispatch_ticket_correction', async () => {
    const { pglite, orgAId, closedTicketAId, userAId } = env;

    // Seed one correction row first (superuser, GUC set).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
      reason: 'DC2 seed row',
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Clear GUC → fail-closed: 0 rows.
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const r = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM dispatch_ticket_correction`,
    );
    expect(r.rows[0]!.count).toBe('0');
  });

  // ── DC3: RLS isolation (cross-org SELECT → 0) ───────────────────────────────

  it('DC3: RLS isolation — org A cannot see org B correction rows', async () => {
    const { pglite, db, orgAId, orgBId, closedTicketBId, userBId } = env;

    // Seed a correction in org B (superuser).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await insertCorrection(pglite, orgBId, closedTicketBId, userBId, {
      reason: 'DC3 org B seed',
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Org A context → only org A corrections visible.
    const rowsA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(dispatchTicketCorrection).execute(),
    );
    expect(rowsA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsA.some((r) => r.orgId === orgBId)).toBe(false);

    // Org B context → only org B corrections visible.
    const rowsB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(dispatchTicketCorrection).execute(),
    );
    expect(rowsB.every((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsB.some((r) => r.orgId === orgAId)).toBe(false);
  });

  // ── DC4: APPEND-ONLY (headline records-integrity guarantee) ──────────────────
  //
  // Mirrors T14 (audit_log) in rls-isolation.test.ts exactly.
  // The absence of UPDATE/DELETE policies under FORCE RLS, combined with
  // REVOKE UPDATE, DELETE FROM aeroops_app, means both operations are
  // structurally blocked — they throw rather than silently affecting 0 rows.

  it('DC4a: UPDATE a correction row as aeroops_app is REJECTED (no UPDATE policy + REVOKE)', async () => {
    const { pglite, orgAId, closedTicketAId, userAId } = env;

    // Seed a correction to attempt updating.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const rowId = await insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
      reason: 'DC4a seed — will attempt tamper',
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Attempt UPDATE as aeroops_app with GUC set — must be rejected.
    await pglite.exec(`SELECT set_config('app.current_org_id', '${orgAId}', false)`);
    await expect(
      pglite.query(
        `UPDATE dispatch_ticket_correction
         SET reason = 'tampered'
         WHERE id = $1
         RETURNING id`,
        [rowId],
      ),
    ).rejects.toThrow();
  });

  it('DC4b: DELETE a correction row as aeroops_app is REJECTED (no DELETE policy + REVOKE)', async () => {
    const { pglite, orgAId, closedTicketAId, userAId } = env;

    // Seed a correction to attempt deleting.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const rowId = await insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
      reason: 'DC4b seed — will attempt delete',
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Attempt DELETE as aeroops_app with GUC set — must be rejected.
    await pglite.exec(`SELECT set_config('app.current_org_id', '${orgAId}', false)`);
    await expect(
      pglite.query(
        `DELETE FROM dispatch_ticket_correction WHERE id = $1 RETURNING id`,
        [rowId],
      ),
    ).rejects.toThrow();
  });

  it('DC4c: row is untouched after rejected UPDATE (original data intact)', async () => {
    const { pglite, db, orgAId, closedTicketAId, userAId } = env;
    const originalReason = 'DC4c — original reason must survive tamper attempt';

    // Seed a correction.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const rowId = await insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
      correctedHobbs: 103.3,
      correctedTach: null,
      reason: originalReason,
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Attempt UPDATE — expect rejection.
    await pglite.exec(`SELECT set_config('app.current_org_id', '${orgAId}', false)`);
    await expect(
      pglite.query(
        `UPDATE dispatch_ticket_correction SET reason = 'tampered' WHERE id = $1`,
        [rowId],
      ),
    ).rejects.toThrow();

    // Row must have original data.
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(dispatchTicketCorrection).execute(),
    );
    const theRow = rows.find((r) => r.id === rowId);
    expect(theRow).toBeDefined();
    expect(theRow!.reason).toBe(originalReason);
  });

  it('DC4d: row still exists after rejected DELETE (verified via superuser)', async () => {
    const { pglite, orgAId, closedTicketAId, userAId } = env;

    // Seed a correction.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const rowId = await insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
      reason: 'DC4d seed — must survive DELETE attempt',
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Attempt DELETE — expect rejection.
    await pglite.exec(`SELECT set_config('app.current_org_id', '${orgAId}', false)`);
    await expect(
      pglite.query(
        `DELETE FROM dispatch_ticket_correction WHERE id = $1`,
        [rowId],
      ),
    ).rejects.toThrow();

    // Verify via superuser that the row still exists.
    await pglite.exec(`SET ROLE postgres`);
    const check = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM dispatch_ticket_correction WHERE id = $1`,
      [rowId],
    );
    expect(check.rows[0]!.count).toBe('1');
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── DC5: Composite FK cross-org rejection ────────────────────────────────────

  it('DC5a: cross-org dispatch_ticket_id (ticket from org B with org_id of org A) → FK rejected', async () => {
    const { pglite, orgAId, closedTicketBId, userAId } = env;

    // Attempt to insert a correction in org A referencing org B's ticket.
    // The composite FK (dispatch_ticket_id, org_id) → dispatch_ticket must reject this.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertCorrection(pglite, orgAId, closedTicketBId, userAId, {
        reason: 'DC5a cross-org ticket attempt',
      }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('DC5b: cross-org created_by (user from org B with org_id of org A) → FK rejected', async () => {
    const { pglite, orgAId, closedTicketAId, userBId } = env;

    // Attempt to insert a correction in org A with org B's user as created_by.
    // The composite FK (created_by, org_id) → app_user must reject this.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertCorrection(pglite, orgAId, closedTicketAId, userBId, {
        reason: 'DC5b cross-org created_by attempt',
      }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── DC6: RESTRICT FK integrity ───────────────────────────────────────────────

  it('DC6a: hard-deleting a dispatch_ticket that has a correction → REJECTED (RESTRICT)', async () => {
    const { pglite, orgAId, closedTicketAId, userAId } = env;

    // Ensure at least one correction exists for the ticket (seed if needed).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
      reason: 'DC6a RESTRICT seed',
    });
    await pglite.exec(`COMMIT`);

    // Attempt to hard-delete the dispatch_ticket — RESTRICT must block it.
    await expect(
      pglite.query(`DELETE FROM dispatch_ticket WHERE id = $1`, [closedTicketAId]),
    ).rejects.toThrow();
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('DC6b: hard-deleting app_user (created_by) that has a correction → REJECTED (RESTRICT)', async () => {
    const { pglite, orgAId, closedTicketAId } = env;

    // Create a throwaway user and seed one correction authored by that user.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);

    const uRow = await pglite.query<{ id: string }>(
      `INSERT INTO app_user (org_id, email, full_name)
       VALUES ($1, 'restrict-test@alpha-corr.example', 'RESTRICT Test Author')
       RETURNING id`,
      [orgAId],
    );
    const throwUserId = uRow.rows[0]!.id;

    await insertCorrection(pglite, orgAId, closedTicketAId, throwUserId, {
      reason: 'DC6b RESTRICT author seed',
    });
    await pglite.exec(`COMMIT`);

    // Attempt to delete the throwaway user — RESTRICT on (created_by, org_id) must block it.
    await expect(
      pglite.query(`DELETE FROM app_user WHERE id = $1`, [throwUserId]),
    ).rejects.toThrow();
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── DC7: CHECKs fire ─────────────────────────────────────────────────────────

  it('DC7a: correction_at_least_one_meter_check: both meters NULL → rejected', async () => {
    const { pglite, orgAId, closedTicketAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
        correctedHobbs: null,
        correctedTach: null,
        reason: 'both null meters',
      }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('DC7b: correction_hobbs_nonneg_check: negative corrected_hobbs → rejected', async () => {
    const { pglite, orgAId, closedTicketAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
        correctedHobbs: -0.1,
        correctedTach: 97.7,
        reason: 'negative hobbs',
      }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('DC7c: correction_tach_nonneg_check: negative corrected_tach → rejected', async () => {
    const { pglite, orgAId, closedTicketAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
        correctedHobbs: 102.2,
        correctedTach: -5.0,
        reason: 'negative tach',
      }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('DC7d: correction_reason_nonempty_check: empty string reason → rejected', async () => {
    const { pglite, orgAId, closedTicketAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
        reason: '',
      }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('DC7e: correction_reason_nonempty_check: whitespace-only reason → rejected', async () => {
    const { pglite, orgAId, closedTicketAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
        reason: '   ',
      }),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('DC7f: hobbs-only correction (corrected_tach = NULL) → accepted', async () => {
    const { pglite, orgAId, closedTicketAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const id = await insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
      correctedHobbs: 102.2,
      correctedTach: null,
      reason: 'DC7f hobbs-only',
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await pglite.exec(`COMMIT`);
  });

  it('DC7g: tach-only correction (corrected_hobbs = NULL) → accepted', async () => {
    const { pglite, orgAId, closedTicketAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const id = await insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
      correctedHobbs: null,
      correctedTach: 97.7,
      reason: 'DC7g tach-only',
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await pglite.exec(`COMMIT`);
  });

  // ── DC8: UNIQUE(id, org_id) composite candidate key index ────────────────────

  it('DC8: UNIQUE(id, org_id) composite candidate key index exists on dispatch_ticket_correction', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM pg_indexes
         WHERE tablename = 'dispatch_ticket_correction'
           AND indexname = 'dispatch_ticket_correction_id_org_id_unique'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  // ── DC9: Happy-path round-trips ───────────────────────────────────────────────

  it('DC9a: single correction for a seeded dispatch_ticket round-trips', async () => {
    const { pglite, db, orgAId, closedTicketAId, userAId } = env;
    const expectedReason = 'DC9a round-trip — Hobbs counter fault confirmed by mechanic';

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const corrId = await insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
      correctedHobbs: 101.5,
      correctedTach: 96.9,
      reason: expectedReason,
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Read back via Drizzle under org A context.
    await pglite.exec(`SELECT set_config('app.current_org_id', '${orgAId}', false)`);
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(dispatchTicketCorrection).execute(),
    );
    const theRow = rows.find((r) => r.id === corrId);
    expect(theRow).toBeDefined();
    expect(theRow!.orgId).toBe(orgAId);
    expect(theRow!.dispatchTicketId).toBe(closedTicketAId);
    expect(theRow!.createdBy).toBe(userAId);
    expect(theRow!.reason).toBe(expectedReason);
    expect(theRow!.correctedHobbs).toBe('101.5');
    expect(theRow!.correctedTach).toBe('96.9');
    expect(theRow!.createdAt).toBeInstanceOf(Date);
  });

  it('DC9b: multiple corrections for the same ticket coexist (append-only — no row removed)', async () => {
    const { pglite, db, orgAId, closedTicketAId, userAId } = env;

    // Insert three corrections in sequence.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const id1 = await insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
      correctedHobbs: 101.1,
      correctedTach: null,
      reason: 'DC9b first correction',
    });
    const id2 = await insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
      correctedHobbs: 101.2,
      correctedTach: null,
      reason: 'DC9b second correction',
    });
    const id3 = await insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
      correctedHobbs: 101.3,
      correctedTach: null,
      reason: 'DC9b third correction',
    });
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // All three corrections should coexist; none should have been removed.
    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(dispatchTicketCorrection).execute(),
    );
    const corrIds = rows.map((r) => r.id);
    expect(corrIds).toContain(id1);
    expect(corrIds).toContain(id2);
    expect(corrIds).toContain(id3);
  });

  it('DC9c: ORDER BY created_at DESC LIMIT 1 returns the latest correction', async () => {
    const { pglite, orgAId, closedTicketAId, userAId } = env;

    // Insert two corrections with different reasons.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertCorrection(pglite, orgAId, closedTicketAId, userAId, {
      correctedHobbs: 104.0,
      correctedTach: null,
      reason: 'DC9c earlier correction',
    });
    // Small sleep not practical in PGlite; use pg clock trick: insert with explicit
    // created_at offsets so ordering is deterministic.
    const r2 = await pglite.query<{ id: string }>(
      `INSERT INTO dispatch_ticket_correction
         (org_id, dispatch_ticket_id, corrected_hobbs, corrected_tach,
          reason, created_by, created_at)
       VALUES ($1, $2, 105.0, NULL, 'DC9c latest correction', $3,
               now() + interval '1 second')
       RETURNING id`,
      [orgAId, closedTicketAId, userAId],
    );
    const latestId = r2.rows[0]!.id;
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Effective-meter query: latest correction per ticket.
    await pglite.exec(`SELECT set_config('app.current_org_id', '${orgAId}', false)`);
    const result = await pglite.query<{ id: string; corrected_hobbs: string; reason: string }>(
      `SELECT id, corrected_hobbs, reason
       FROM dispatch_ticket_correction
       WHERE org_id = $1 AND dispatch_ticket_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [orgAId, closedTicketAId],
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.id).toBe(latestId);
    expect(result.rows[0]!.corrected_hobbs).toBe('105.0');
    expect(result.rows[0]!.reason).toBe('DC9c latest correction');
  });

  it('DC9d: correction_org_ticket_created_idx index exists (effective-meter query pattern)', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM pg_indexes
         WHERE tablename = 'dispatch_ticket_correction'
           AND indexname = 'correction_org_ticket_created_idx'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  // ── DC10: Down migration reverses 0018 ───────────────────────────────────────

  it('DC10: down migration reverses 0018 — table + policies gone after down', async () => {
    // Use a fresh isolated PGlite client to avoid polluting the shared env.
    const { pglite: pg2 } = await createTestClient();
    await applyMigrationSql({ pglite: pg2 }, MIGRATION_SQL);

    // Verify table exists before down.
    const before = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_ticket_correction'
       ) AS exists`,
    );
    expect(before.rows[0]!.exists).toBe(true);

    // Verify SELECT policy exists before down.
    const beforePolicy = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM pg_policies
         WHERE tablename = 'dispatch_ticket_correction'
           AND policyname = 'dispatch_ticket_correction_select'
       ) AS exists`,
    );
    expect(beforePolicy.rows[0]!.exists).toBe(true);

    // Apply the down migration.
    await pg2.exec(DOWN_0018);

    // Table must be gone.
    const after = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_ticket_correction'
       ) AS exists`,
    );
    expect(after.rows[0]!.exists).toBe(false);

    // Policies must be gone (table drop cascades; also explicit DROP POLICY in down).
    const afterPolicy = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM pg_policies
         WHERE tablename = 'dispatch_ticket_correction'
       ) AS exists`,
    );
    expect(afterPolicy.rows[0]!.exists).toBe(false);

    // Index must be gone (index on dropped table).
    const afterIdx = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM pg_indexes
         WHERE tablename = 'dispatch_ticket_correction'
           AND indexname = 'correction_org_ticket_created_idx'
       ) AS exists`,
    );
    expect(afterIdx.rows[0]!.exists).toBe(false);
  });
});
