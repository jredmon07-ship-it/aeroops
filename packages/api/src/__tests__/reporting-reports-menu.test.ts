/**
 * reporting-reports-menu.test.ts — Integration tests for getSquawksReport and
 * getMaintenanceRemindersReport (the reporting-side FC canned reports).
 *
 * Applies migrations 0000–0040 via the shared loader.
 *
 * COVERAGE (both reads):
 *   CAPS: reporting:access required. dispatcher (has reporting:access) passes;
 *     renter (no reporting:access) ⇒ Forbidden; null ⇒ Unauthenticated.
 *   HAPPY: org-wide rows, tail number enriched, status counts; optional status
 *     filter narrows the rows.
 *   T-ISO: org-A session never sees org-B rows; org B sees only its own.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  seedTwoOrgs,
  loadMigrationSql,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { reportSquawkWithDb } from '../maintenance/report-squawk.js';
import { updateSquawkStatusWithDb } from '../maintenance/update-squawk-status.js';
import { createMaintenanceItemWithDb } from '../maintenance/create-maintenance-item.js';
import { getSquawksReportWithDb } from '../reporting/get-squawks-report.js';
import { getMaintenanceRemindersReportWithDb } from '../reporting/get-maintenance-reminders-report.js';

import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

const MIGRATION_SQL = loadMigrationSql('0040');

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
}

function makeSession(orgId: string, userId: string, role: AppSession['role'] = 'owner'): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

let env: TestEnv;
let acAId = '';

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });
  env = {
    db,
    pglite,
    orgAId: seed.orgAId,
    orgBId: seed.orgBId,
    userAId: seed.userAId,
    userBId: seed.userBId,
  };

  const sessA = makeSession(env.orgAId, env.userAId, 'owner');
  const sessB = makeSession(env.orgBId, env.userBId, 'owner');

  // ── Org A ── one aircraft, two squawks (one resolved), one overdue mx item.
  const acA = await createResourceWithDb(db, sessA, {
    kind: 'aircraft',
    displayName: 'Alpha',
    tailNumber: 'N-ALPHA',
  });
  acAId = acA.id;
  await reportSquawkWithDb(db, sessA, { resourceId: acAId, title: 'A open squawk', severity: 'low' });
  const sq2 = await reportSquawkWithDb(db, sessA, {
    resourceId: acAId,
    title: 'A resolved squawk',
    severity: 'medium',
  });
  if (!sq2.ok) throw new Error('squawk 2 failed');
  await updateSquawkStatusWithDb(db, sessA, { squawkId: sq2.squawk.id, status: 'resolved' });

  const mxA = await createMaintenanceItemWithDb(db, sessA, {
    resourceId: acAId,
    title: 'Annual inspection',
    trackBy: 'date',
    dueDate: '2020-01-01', // in the past ⇒ overdue
  });
  if (!mxA.ok) throw new Error('mx item A failed');

  // ── Org B ── one aircraft, one squawk, one mx item (isolation fixture).
  const acB = await createResourceWithDb(db, sessB, {
    kind: 'aircraft',
    displayName: 'Bravo',
    tailNumber: 'N-BRAVO',
  });
  await reportSquawkWithDb(db, sessB, { resourceId: acB.id, title: 'B only squawk', severity: 'high' });
  const mxB = await createMaintenanceItemWithDb(db, sessB, {
    resourceId: acB.id,
    title: 'B only inspection',
    trackBy: 'date',
    dueDate: '2020-06-01',
  });
  if (!mxB.ok) throw new Error('mx item B failed');
}, 180_000);

// ════════════════════════════════════════════════════════════════════════════════
// getSquawksReport
// ════════════════════════════════════════════════════════════════════════════════

describe('getSquawksReport — caps', () => {
  it('null session ⇒ Unauthenticated', async () => {
    await expect(getSquawksReportWithDb(env.db, null, {})).rejects.toThrow(UnauthenticatedError);
  });

  it('dispatcher (reporting:access) ⇒ allowed', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    const r = await getSquawksReportWithDb(env.db, sess, {});
    expect(Array.isArray(r.rows)).toBe(true);
  });

  it('renter (no reporting:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(getSquawksReportWithDb(env.db, sess, {})).rejects.toThrow(ForbiddenError);
  });
});

describe('getSquawksReport — happy', () => {
  it('org-wide rows with tail number + status counts', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getSquawksReportWithDb(env.db, sess, {});
    expect(r.rows.length).toBe(2);
    expect(r.openCount).toBe(1);
    expect(r.resolvedCount).toBe(1);
    expect(r.rows.every((row) => row.tailNumber === 'N-ALPHA')).toBe(true);
  });

  it('status filter narrows to open only', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getSquawksReportWithDb(env.db, sess, { status: 'open' });
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.status).toBe('open');
  });
});

describe('getSquawksReport — T-ISO', () => {
  it('org-A never sees org-B squawk', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getSquawksReportWithDb(env.db, sess, {});
    expect(r.rows.some((row) => row.title === 'B only squawk')).toBe(false);
  });

  it('org-B sees only its own squawk', async () => {
    const sess = makeSession(env.orgBId, env.userBId, 'owner');
    const r = await getSquawksReportWithDb(env.db, sess, {});
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.title).toBe('B only squawk');
    expect(r.rows[0]!.tailNumber).toBe('N-BRAVO');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// getMaintenanceRemindersReport
// ════════════════════════════════════════════════════════════════════════════════

describe('getMaintenanceRemindersReport — caps', () => {
  it('null session ⇒ Unauthenticated', async () => {
    await expect(getMaintenanceRemindersReportWithDb(env.db, null, {})).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it('dispatcher (reporting:access) ⇒ allowed', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    const r = await getMaintenanceRemindersReportWithDb(env.db, sess, {});
    expect(Array.isArray(r.rows)).toBe(true);
  });

  it('renter (no reporting:access) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(getMaintenanceRemindersReportWithDb(env.db, sess, {})).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe('getMaintenanceRemindersReport — happy', () => {
  it('org-wide rows with tail number + overdue count', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getMaintenanceRemindersReportWithDb(env.db, sess, {});
    expect(r.rows.length).toBe(1);
    expect(r.overdueCount).toBe(1);
    expect(r.rows[0]!.title).toBe('Annual inspection');
    expect(r.rows[0]!.tailNumber).toBe('N-ALPHA');
    expect(r.rows[0]!.status).toBe('overdue');
  });

  it('status filter overdue keeps the row; ok filter drops it', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const overdue = await getMaintenanceRemindersReportWithDb(env.db, sess, { status: 'overdue' });
    expect(overdue.rows.length).toBe(1);
    // Counts stay over the full org regardless of the filter.
    expect(overdue.overdueCount).toBe(1);
    const ok = await getMaintenanceRemindersReportWithDb(env.db, sess, { status: 'ok' });
    expect(ok.rows.length).toBe(0);
    expect(ok.overdueCount).toBe(1);
  });
});

describe('getMaintenanceRemindersReport — T-ISO', () => {
  it('org-A never sees org-B maintenance item', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await getMaintenanceRemindersReportWithDb(env.db, sess, {});
    expect(r.rows.some((row) => row.title === 'B only inspection')).toBe(false);
  });

  it('org-B sees only its own maintenance item', async () => {
    const sess = makeSession(env.orgBId, env.userBId, 'owner');
    const r = await getMaintenanceRemindersReportWithDb(env.db, sess, {});
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.title).toBe('B only inspection');
    expect(r.rows[0]!.tailNumber).toBe('N-BRAVO');
  });
});
