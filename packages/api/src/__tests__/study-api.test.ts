/**
 * study-api.test.ts — Slice STUDY-1: AeroStudy integration server seam.
 *
 * Applies migrations 0000–0035 (0035 = study_grant + study_progress —
 * applying it here also validates the STAGED migration SQL itself against
 * PGlite before any human runs it for real).
 * Uses PGlite + *WithDb forms; two-org seed (seedTwoOrgs) + a seedMember
 * helper (mirrors alerts-api.test.ts).
 *
 * THE HEADLINE: SELF-SCOPING. Entitlements and progress are ALWAYS keyed by
 * session.userId from the verified token — a member never reads another
 * member's grants nor writes another member's progress.
 *
 * COVERAGE:
 *   UNIT (pure)  — mapScopesToEntitlements / isValidCertCode /
 *                  parseStudyProgressInput / computeEntitlementsExpiresAt /
 *                  isMissingRelationError
 *   E1–E7        — entitlements read: empty / all_access / cert codes
 *                  (dedupe+sort) / revoked excluded / self-scope / T-ISO /
 *                  authz
 *   G1–G2        — study_grant partial-unique backstop: duplicate ACTIVE
 *                  grant refused; revoke-then-re-grant allowed
 *   P1–P5        — progress upsert: insert / update-in-place (one row) /
 *                  ValidationError / self-scope + T-ISO / authz
 *   M1–M2        — ships-before-migration: a DB WITHOUT 0035 →
 *                  StudyTablesNotMigratedError from both surfaces
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  appUser,
  membership,
  studyGrant,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { getStudyEntitlementsWithDb } from '../study/get-study-entitlements.js';
import { upsertStudyProgressWithDb } from '../study/upsert-study-progress.js';
import {
  mapScopesToEntitlements,
  isValidCertCode,
  parseStudyProgressInput,
  computeEntitlementsExpiresAt,
  isMissingRelationError,
  StudyTablesNotMigratedError,
} from '../study/internal.js';
import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import type { AppSession } from '../auth/types.js';
import { extractRows } from '../db-rows.js';

// ── Path resolution ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function migrationSql(name: string): string {
  return readFileSync(resolve(__dirname, `../../../db/migrations/${name}`), 'utf-8');
}

const MIGRATION_SQL_THROUGH_0034 = [
  migrationSql('0000_loud_prodigy.sql'),
  migrationSql('0001_auth_credential.sql'),
  migrationSql('0002_scheduling.sql'),
  migrationSql('0003_booking_policies.sql'),
  migrationSql('0004_recurrence.sql'),
  migrationSql('0005_dispatch.sql'),
  migrationSql('0006_squawks_grounding.sql'),
  migrationSql('0007_fleet.sql'),
  migrationSql('0008_people.sql'),
  migrationSql('0009_dispatch_gate.sql'),
  migrationSql('0010_civil_twilight.sql'),
  migrationSql('0011_optimizer_run.sql'),
  migrationSql('0012_training.sql'),
  migrationSql('0013_work_orders.sql'),
  migrationSql('0014_availability.sql'),
  migrationSql('0015_booking_request.sql'),
  migrationSql('0016_booking_request_convert.sql'),
  migrationSql('0017_booking_retention.sql'),
  migrationSql('0018_dispatch_ticket_correction.sql'),
  migrationSql('0019_billing_records.sql'),
  migrationSql('0020_demo_reset_state.sql'),
  migrationSql('0021_qbo_integration.sql'),
  migrationSql('0022_billing_ledger.sql'),
  migrationSql('0023_stripe_foundation.sql'),
  migrationSql('0024_payment_methods_autopay.sql'),
  migrationSql('0025_recurring_dues.sql'),
  migrationSql('0026_notifications.sql'),
  migrationSql('0027_data_import.sql'),
  migrationSql('0028_calendar_feed.sql'),
  migrationSql('0029_maintenance_due.sql'),
  migrationSql('0030_documents.sql'),
  migrationSql('0031_pos_sales.sql'),
  migrationSql('0032_lesson_signature.sql'),
  migrationSql('0033_mobile_session.sql'),
  migrationSql('0034_block_time.sql'),
];

const MIGRATION_SQL = [
  ...MIGRATION_SQL_THROUGH_0034,
  migrationSql('0035_study_grant.sql'),
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'] = 'student',
): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

/** Seed a member (app_user + membership) in an org. Returns userId. */
async function seedMember(
  db: PgliteTestClient,
  orgId: string,
  email: string,
  role: AppSession['role'],
): Promise<string> {
  return withOrgContext(db, orgId, async (tx) => {
    const [usr] = await tx
      .insert(appUser)
      .values({ orgId, email, fullName: `User ${email}`, status: 'active' })
      .returning();
    await tx.insert(membership).values({ orgId, userId: usr!.id, role });
    return usr!.id;
  });
}

/** Insert a study_grant row (as the org, RLS-scoped). Returns the grant id. */
async function seedGrant(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  scope: string,
  grantedBy: string,
): Promise<string> {
  return withOrgContext(db, orgId, async (tx) => {
    const [row] = await tx
      .insert(studyGrant)
      .values({ orgId, userId, scope, grantedBy })
      .returning();
    return row!.id;
  });
}

/** Soft-revoke a grant (sets revoked_at, never DELETE). */
async function revokeGrant(db: PgliteTestClient, orgId: string, grantId: string): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    await tx
      .update(studyGrant)
      .set({ revokedAt: new Date() })
      .where(and(eq(studyGrant.id, grantId), eq(studyGrant.orgId, orgId)));
  });
}

const NOW = new Date('2026-07-06T12:00:00.000Z');
const NOW_PLUS_7D = '2026-07-13T12:00:00.000Z';

// ── Shared test env ───────────────────────────────────────────────────────────

interface StudyEnv {
  db: PgliteTestClient;
  orgAId: string;
  orgBId: string;
  ownerAId: string;   // org-A owner (grantedBy attribution)
  ownerBId: string;   // org-B owner
  studentA1Id: string; // org-A student with grants
  studentA2Id: string; // org-A student WITHOUT grants (self-scope check)
  studentBId: string;  // org-B student (T-ISO)
}

let env: StudyEnv;

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });

  const studentA1Id = await seedMember(db, seed.orgAId, 'studentA1@alpha.example', 'student');
  const studentA2Id = await seedMember(db, seed.orgAId, 'studentA2@alpha.example', 'student');
  const studentBId  = await seedMember(db, seed.orgBId, 'studentB@beta.example', 'student');

  env = {
    db,
    orgAId: seed.orgAId,
    orgBId: seed.orgBId,
    ownerAId: seed.userAId,
    ownerBId: seed.userBId,
    studentA1Id,
    studentA2Id,
    studentBId,
  };
}, 120_000);

// ══════════════════════════════════════════════════════════════════════════════
// UNIT — pure helpers
// ══════════════════════════════════════════════════════════════════════════════

describe('mapScopesToEntitlements (pure)', () => {
  it('empty scopes → no access', () => {
    expect(mapScopesToEntitlements([])).toEqual({
      hasAllAccess: false,
      unlockedCertCodes: [],
    });
  });

  it("'all_access' → hasAllAccess true", () => {
    expect(mapScopesToEntitlements(['all_access'])).toEqual({
      hasAllAccess: true,
      unlockedCertCodes: [],
    });
  });

  it('cert codes are deduplicated and sorted', () => {
    expect(mapScopesToEntitlements(['PAR', 'IRA', 'PAR', 'CAX'])).toEqual({
      hasAllAccess: false,
      unlockedCertCodes: ['CAX', 'IRA', 'PAR'],
    });
  });

  it('all_access + cert codes coexist (client merges sets)', () => {
    expect(mapScopesToEntitlements(['PAR', 'all_access'])).toEqual({
      hasAllAccess: true,
      unlockedCertCodes: ['PAR'],
    });
  });

  it('malformed scopes are dropped, never granted (fail-closed)', () => {
    expect(
      mapScopesToEntitlements(['par', '', 'ALL_ACCESS_PLEASE?', 'X', 'A23456789012', 'IRA']),
    ).toEqual({ hasAllAccess: false, unlockedCertCodes: ['IRA'] });
  });
});

describe('isValidCertCode (pure)', () => {
  it('accepts uppercase alphanumeric 2–10 starting with a letter', () => {
    for (const good of ['PAR', 'IRA', 'CAX', 'A1', 'FOI', 'ABCDEFGHIJ']) {
      expect(isValidCertCode(good), good).toBe(true);
    }
  });

  it('rejects lowercase, too short/long, leading digit, and all_access', () => {
    for (const bad of ['par', 'P', '', '1AR', 'ABCDEFGHIJK', 'all_access', 'PA R', 'PA-R']) {
      expect(isValidCertCode(bad), bad).toBe(false);
    }
  });
});

describe('parseStudyProgressInput (pure)', () => {
  const valid = {
    certCode: 'PAR',
    readinessPercent: 0.62,
    questionsLogged: 140,
    lastStudiedAt: '2026-07-05T21:15:00Z',
  };

  it('accepts a valid payload and normalizes lastStudiedAt to a Date', () => {
    const r = parseStudyProgressInput(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.certCode).toBe('PAR');
    expect(r.input.readinessPercent).toBe(0.62);
    expect(r.input.questionsLogged).toBe(140);
    expect(r.input.lastStudiedAt).toBeInstanceOf(Date);
    expect(r.input.lastStudiedAt.toISOString()).toBe('2026-07-05T21:15:00.000Z');
  });

  it('accepts boundary readiness 0 and 1 and questionsLogged 0', () => {
    expect(
      parseStudyProgressInput({ ...valid, readinessPercent: 0, questionsLogged: 0 }).ok,
    ).toBe(true);
    expect(parseStudyProgressInput({ ...valid, readinessPercent: 1 }).ok).toBe(true);
  });

  it('rejects a non-object / array / null body', () => {
    for (const bad of [null, undefined, 'str', 42, [valid]]) {
      const r = parseStudyProgressInput(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/JSON object/);
    }
  });

  it("rejects a bad certCode (including 'all_access' — progress is per-cert)", () => {
    for (const bad of [undefined, 7, 'par', 'all_access', '']) {
      const r = parseStudyProgressInput({ ...valid, certCode: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/certCode/);
    }
  });

  it('rejects out-of-range / non-finite / non-number readinessPercent', () => {
    for (const bad of [-0.01, 1.01, NaN, Infinity, '0.5', undefined]) {
      const r = parseStudyProgressInput({ ...valid, readinessPercent: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/readinessPercent/);
    }
  });

  it('rejects negative / fractional / unsafe questionsLogged', () => {
    for (const bad of [-1, 1.5, NaN, Infinity, '3', 2 ** 53]) {
      const r = parseStudyProgressInput({ ...valid, questionsLogged: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/questionsLogged/);
    }
  });

  it('rejects a missing or unparseable lastStudiedAt', () => {
    for (const bad of [undefined, 12345, 'not-a-date', '']) {
      const r = parseStudyProgressInput({ ...valid, lastStudiedAt: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/lastStudiedAt/);
    }
  });
});

describe('computeEntitlementsExpiresAt (pure)', () => {
  it('is exactly now + 7 days, ISO-8601', () => {
    expect(computeEntitlementsExpiresAt(NOW)).toBe(NOW_PLUS_7D);
  });
});

describe('isMissingRelationError (pure)', () => {
  it('detects SQLSTATE 42P01 on the error itself', () => {
    const err = Object.assign(new Error('boom'), { code: '42P01' });
    expect(isMissingRelationError(err)).toBe(true);
  });

  it('detects 42P01 down the cause chain', () => {
    const cause = Object.assign(new Error('inner'), { code: '42P01' });
    const outer = new Error('query failed', { cause });
    expect(isMissingRelationError(outer)).toBe(true);
  });

  it('detects the standard message when no code survives wrapping', () => {
    expect(
      isMissingRelationError(new Error('relation "study_grant" does not exist')),
    ).toBe(true);
  });

  it('is false for other errors and non-errors', () => {
    expect(isMissingRelationError(new Error('duplicate key'))).toBe(false);
    expect(isMissingRelationError(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
    expect(isMissingRelationError('relation "x" does not exist')).toBe(false);
    expect(isMissingRelationError(null)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// INTEGRATION — entitlements read (E1–E7)
// ══════════════════════════════════════════════════════════════════════════════

describe('getStudyEntitlements', () => {
  it('E1 — no grants → empty entitlements with expiresAt = now + 7d', async () => {
    const res = await getStudyEntitlementsWithDb(
      env.db,
      makeSession(env.orgAId, env.studentA2Id),
      NOW,
    );
    expect(res).toEqual({
      hasAllAccess: false,
      unlockedCertCodes: [],
      expiresAt: NOW_PLUS_7D,
    });
  });

  it("E2/E3 — 'all_access' + cert grants fold to the entitlement state (sorted)", async () => {
    await seedGrant(env.db, env.orgAId, env.studentA1Id, 'PAR', env.ownerAId);
    await seedGrant(env.db, env.orgAId, env.studentA1Id, 'IRA', env.ownerAId);
    await seedGrant(env.db, env.orgAId, env.studentA1Id, 'all_access', env.ownerAId);

    const res = await getStudyEntitlementsWithDb(
      env.db,
      makeSession(env.orgAId, env.studentA1Id),
      NOW,
    );
    expect(res.hasAllAccess).toBe(true);
    expect(res.unlockedCertCodes).toEqual(['IRA', 'PAR']);
    expect(res.expiresAt).toBe(NOW_PLUS_7D);
  });

  it('E4 — a revoked grant stops contributing', async () => {
    const grantId = await seedGrant(env.db, env.orgAId, env.studentA2Id, 'CAX', env.ownerAId);
    let res = await getStudyEntitlementsWithDb(
      env.db,
      makeSession(env.orgAId, env.studentA2Id),
      NOW,
    );
    expect(res.unlockedCertCodes).toEqual(['CAX']);

    await revokeGrant(env.db, env.orgAId, grantId);
    res = await getStudyEntitlementsWithDb(
      env.db,
      makeSession(env.orgAId, env.studentA2Id),
      NOW,
    );
    expect(res.unlockedCertCodes).toEqual([]);
    expect(res.hasAllAccess).toBe(false);
  });

  it("E5 — SELF-SCOPE: A2 never sees A1's grants (same org)", async () => {
    const res = await getStudyEntitlementsWithDb(
      env.db,
      makeSession(env.orgAId, env.studentA2Id),
      NOW,
    );
    // A1 holds all_access + PAR + IRA; A2 holds nothing (CAX was revoked).
    expect(res.hasAllAccess).toBe(false);
    expect(res.unlockedCertCodes).toEqual([]);
  });

  it("E6 — T-ISO: org-B's grants are invisible to an org-A session", async () => {
    await seedGrant(env.db, env.orgBId, env.studentBId, 'all_access', env.ownerBId);

    // org-B member sees their grant…
    const bRes = await getStudyEntitlementsWithDb(
      env.db,
      makeSession(env.orgBId, env.studentBId),
      NOW,
    );
    expect(bRes.hasAllAccess).toBe(true);

    // …and an org-A session (even probing with B's userId) sees NOTHING:
    // RLS scopes to org A, where that user has no rows.
    const probe = await getStudyEntitlementsWithDb(
      env.db,
      makeSession(env.orgAId, env.studentBId),
      NOW,
    );
    expect(probe).toEqual({
      hasAllAccess: false,
      unlockedCertCodes: [],
      expiresAt: NOW_PLUS_7D,
    });
  });

  it('E7 — authz: null session → UnauthenticatedError', async () => {
    await expect(getStudyEntitlementsWithDb(env.db, null, NOW)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// INTEGRATION — study_grant partial-unique backstop (G1–G2)
// ══════════════════════════════════════════════════════════════════════════════

describe('study_grant active-grant uniqueness (migration 0035 backstop)', () => {
  it('G1 — a duplicate ACTIVE (org, user, scope) grant is refused by the DB', async () => {
    await seedGrant(env.db, env.orgAId, env.studentA2Id, 'FOI', env.ownerAId);
    const err: unknown = await seedGrant(
      env.db,
      env.orgAId,
      env.studentA2Id,
      'FOI',
      env.ownerAId,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    // Drizzle wraps the driver error — the unique-violation detail lives in
    // the cause chain. Collect messages down the (bounded) chain.
    const messages: string[] = [];
    let current: unknown = err;
    for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
      messages.push(current.message);
      current = current.cause;
    }
    expect(messages.join(' | ')).toMatch(
      /study_grant_org_user_scope_active_unique|duplicate key/,
    );
  });

  it('G2 — revoke-then-re-grant of the same scope is allowed (history repeats)', async () => {
    const grants = await withOrgContext(env.db, env.orgAId, async (tx) => {
      return tx
        .select({ id: studyGrant.id })
        .from(studyGrant)
        .where(
          and(
            eq(studyGrant.userId, env.studentA2Id),
            eq(studyGrant.scope, 'FOI'),
          ),
        );
    });
    await revokeGrant(env.db, env.orgAId, grants[0]!.id);

    // Re-grant succeeds: the partial unique index ignores revoked rows.
    await seedGrant(env.db, env.orgAId, env.studentA2Id, 'FOI', env.ownerAId);
    const res = await getStudyEntitlementsWithDb(
      env.db,
      makeSession(env.orgAId, env.studentA2Id),
      NOW,
    );
    expect(res.unlockedCertCodes).toContain('FOI');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// INTEGRATION — progress upsert (P1–P5)
// ══════════════════════════════════════════════════════════════════════════════

describe('upsertStudyProgress', () => {
  const payload = {
    certCode: 'PAR',
    readinessPercent: 0.4,
    questionsLogged: 80,
    lastStudiedAt: '2026-07-04T10:00:00Z',
  };

  async function countProgressRows(orgId: string): Promise<number> {
    return withOrgContext(env.db, orgId, async (tx) => {
      const result = await tx.execute(sql`SELECT COUNT(*)::int AS "count" FROM study_progress`);
      const rows = extractRows<{ count: number | string }>(
        result as unknown as Array<{ count: number | string }>,
      );
      const c = rows[0]!.count;
      return typeof c === 'string' ? parseInt(c, 10) : c;
    });
  }

  it('P1 — first upsert inserts and returns the normalized view', async () => {
    const view = await upsertStudyProgressWithDb(
      env.db,
      makeSession(env.orgAId, env.studentA1Id),
      payload,
    );
    expect(view.certCode).toBe('PAR');
    expect(view.readinessPercent).toBeCloseTo(0.4, 6);
    expect(view.questionsLogged).toBe(80);
    expect(view.lastStudiedAt).toBe('2026-07-04T10:00:00.000Z');
    expect(new Date(view.updatedAt).getTime()).toBeGreaterThan(0);
  });

  it('P2 — a second upsert for the same cert UPDATES in place (still one row)', async () => {
    const before = await countProgressRows(env.orgAId);
    const view = await upsertStudyProgressWithDb(
      env.db,
      makeSession(env.orgAId, env.studentA1Id),
      { ...payload, readinessPercent: 0.75, questionsLogged: 210, lastStudiedAt: '2026-07-06T09:30:00Z' },
    );
    expect(view.readinessPercent).toBeCloseTo(0.75, 6);
    expect(view.questionsLogged).toBe(210);
    expect(view.lastStudiedAt).toBe('2026-07-06T09:30:00.000Z');
    expect(await countProgressRows(env.orgAId)).toBe(before);
  });

  it('P3 — an invalid payload throws ValidationError (data layer re-validates)', async () => {
    await expect(
      upsertStudyProgressWithDb(env.db, makeSession(env.orgAId, env.studentA1Id), {
        ...payload,
        readinessPercent: 62, // percent, not a fraction — refused
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      upsertStudyProgressWithDb(env.db, makeSession(env.orgAId, env.studentA1Id), {
        ...payload,
        certCode: 'all_access',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("P4 — SELF-SCOPE + T-ISO: each member's row is their own; orgs never mix", async () => {
    await upsertStudyProgressWithDb(
      env.db,
      makeSession(env.orgAId, env.studentA2Id),
      { ...payload, certCode: 'IRA' },
    );
    await upsertStudyProgressWithDb(
      env.db,
      makeSession(env.orgBId, env.studentBId),
      { ...payload, certCode: 'PAR' },
    );

    const orgARows = await withOrgContext(env.db, env.orgAId, async (tx) => {
      const result = await tx.execute(sql`
        SELECT user_id AS "userId", cert_code AS "certCode" FROM study_progress ORDER BY cert_code
      `);
      return extractRows<{ userId: string; certCode: string }>(
        result as unknown as Array<{ userId: string; certCode: string }>,
      );
    });
    // Org A: A1's PAR + A2's IRA — and NEVER org-B's row.
    expect(orgARows).toEqual([
      { userId: env.studentA2Id, certCode: 'IRA' },
      { userId: env.studentA1Id, certCode: 'PAR' },
    ]);

    const orgBRows = await withOrgContext(env.db, env.orgBId, async (tx) => {
      const result = await tx.execute(sql`
        SELECT user_id AS "userId", cert_code AS "certCode" FROM study_progress
      `);
      return extractRows<{ userId: string; certCode: string }>(
        result as unknown as Array<{ userId: string; certCode: string }>,
      );
    });
    expect(orgBRows).toEqual([{ userId: env.studentBId, certCode: 'PAR' }]);
  });

  it('P5 — authz: null session → UnauthenticatedError (before any validation/IO)', async () => {
    await expect(
      upsertStudyProgressWithDb(env.db, null, payload),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// INTEGRATION — ships-before-migration posture (M1–M2)
// ══════════════════════════════════════════════════════════════════════════════

describe('StudyTablesNotMigratedError when migration 0035 is not applied', () => {
  let dbNoStudy: PgliteTestClient;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL_THROUGH_0034);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    dbNoStudy = db;
    orgId = seed.orgAId;
    userId = seed.userAId;
  }, 120_000);

  it('M1 — entitlements read → StudyTablesNotMigratedError', async () => {
    await expect(
      getStudyEntitlementsWithDb(dbNoStudy, makeSession(orgId, userId, 'owner'), NOW),
    ).rejects.toBeInstanceOf(StudyTablesNotMigratedError);
  });

  it('M2 — progress upsert → StudyTablesNotMigratedError', async () => {
    await expect(
      upsertStudyProgressWithDb(dbNoStudy, makeSession(orgId, userId, 'owner'), {
        certCode: 'PAR',
        readinessPercent: 0.5,
        questionsLogged: 10,
        lastStudiedAt: '2026-07-06T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(StudyTablesNotMigratedError);
  });
});
