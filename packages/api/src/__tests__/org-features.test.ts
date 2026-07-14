/**
 * org-features.test.ts — Integration tests for the per-org module toggle layer
 * (migration 0047): getOrgFeatures / setOrgFeatures, plus the downstream
 * consumers that gate on the flags (global search, public booking submit).
 *
 * Modeled on qbo-sync.test.ts's two-env structure:
 *   env0047 — migration 0047 applied (org_feature_config table exists).
 *   envAbsent — only migration 0046 applied (0047 absent) → GRACEFUL ABSENCE:
 *     getOrgFeatures reads available:false / all-enabled; setOrgFeatures
 *     returns not_available. Byte-identical to the pre-0047 world.
 *
 * COVERAGE:
 *   CAPS: getOrgFeatures requires app:access (null → Unauthenticated; every
 *     role, incl. student, can read). setOrgFeatures requires
 *     org:manage_settings (student/renter → Forbidden; owner → OK).
 *   DEFAULT STATE: an org with no org_feature_config row reads operatingMode
 *     'school', all 8 modules true, available:true.
 *   APPLY PRESET: operatingMode:'club' + applyPreset:true persists the club
 *     preset (training/booking/auto_schedule false, rest true) + writes ONE
 *     audit row 'org.feature_config_changed'.
 *   PARTIAL PATCH: { features: { billing:false } } flips only billing; mode
 *     and every other flag are untouched.
 *   NO-OP: writing the exact current state writes NO new audit row.
 *   T-ISO: org A's config changes are invisible to org B's read.
 *   VALIDATION: {} (neither operatingMode nor features) → ValidationError;
 *     applyPreset:true without operatingMode → ValidationError.
 *   SEARCH GATING: training:false hides the course search group for org A
 *     (owner has training:access — the gate is the module flag, not the cap);
 *     org B (training still on) still surfaces its course.
 *   BOOKING GATE: booking:false → submitBookingRequestWithDb returns
 *     { ok:false, reason:'unavailable' } and inserts no row; booking:true
 *     (the default, org B) → { ok:true } and inserts a row.
 *   GRACEFUL ABSENCE (envAbsent): getOrgFeatures → available:false/all-enabled;
 *     setOrgFeatures → { ok:false, reason:'not_available' }.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  auditLog,
  course,
  loadMigrationSql,
} from '@aeroops/db';
import { and, eq, sql } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';
import { ALL_MODULES_ENABLED, OPERATING_MODE_PRESETS } from '@aeroops/core';

import { getOrgFeaturesWithDb } from '../org-features/get-org-features.js';
import { setOrgFeaturesWithDb } from '../org-features/set-org-features.js';
import { searchOrgWithDb } from '../search/search-org.js';
import { submitBookingRequestWithDb } from '../booking/submit-booking-request.js';

import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import { ValidationError } from '../scheduling/internal.js';
import type { AppSession } from '../auth/types.js';

const MIGRATION_SQL_0047 = loadMigrationSql('0047');
const MIGRATION_SQL_0046 = loadMigrationSql('0046');

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

/** Count 'org.feature_config_changed' audit rows for an org. */
async function countFeatureAuditRows(db: PgliteTestClient, orgId: string): Promise<number> {
  const rows = await withOrgContext(db, orgId, (tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, 'org.feature_config_changed'))),
  );
  return rows.length;
}

/** Insert a course directly and return its id (mirrors search-api.test.ts's insCourse helper). */
async function insCourse(db: PgliteTestClient, orgId: string, title: string, createdBy: string): Promise<string> {
  const [row] = await withOrgContext(db, orgId, (tx) =>
    tx.insert(course).values({ orgId, title, status: 'active', createdBy }).returning(),
  );
  return row!.id;
}

// A future date well within submitBookingRequest's bound window.
const FUTURE_START = '2027-01-15T14:00:00.000Z';

function minimalBookingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Jane Pilot',
    email: 'jane@example.com',
    requestedStart: FUTURE_START,
    ...overrides,
  };
}

/** Count booking_request rows for an org (RLS-scoped read). */
async function countBookingRequests(db: PgliteTestClient, orgId: string): Promise<number> {
  return withOrgContext(db, orgId, async (tx) => {
    const result = await (tx as PgliteTestClient).execute(
      sql`SELECT COUNT(*)::int AS cnt FROM booking_request WHERE org_id = ${orgId}::uuid`,
    );
    const rows = result.rows as Array<{ cnt: number }>;
    return rows[0]?.cnt ?? 0;
  });
}

// ════════════════════════════════════════════════════════════════════════════
// env0047 — full org-features layer live
// ════════════════════════════════════════════════════════════════════════════

describe('org features (migration 0047 applied)', () => {
  let env: TestEnv;

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL_0047);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    env = { db, pglite, orgAId: seed.orgAId, orgBId: seed.orgBId, userAId: seed.userAId, userBId: seed.userBId };
  }, 120_000);

  // ── CAPS: getOrgFeatures ──────────────────────────────────────────────────

  describe('getOrgFeatures caps', () => {
    it('null session → UnauthenticatedError', async () => {
      await expect(getOrgFeaturesWithDb(env.db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
    });

    it('a student session (app:access only) can read', async () => {
      const view = await getOrgFeaturesWithDb(env.db, makeSession(env.orgAId, env.userAId, 'student'));
      expect(view.available).toBe(true);
      expect(view.operatingMode).toBe('school');
    });
  });

  // ── DEFAULT STATE ─────────────────────────────────────────────────────────

  describe('default state (no org_feature_config row yet)', () => {
    it('org A reads operatingMode "school", all 8 modules true, available:true', async () => {
      const view = await getOrgFeaturesWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'));
      expect(view.available).toBe(true);
      expect(view.operatingMode).toBe('school');
      expect(view.features).toEqual(ALL_MODULES_ENABLED);
    });
  });

  // ── CAPS: setOrgFeatures ──────────────────────────────────────────────────

  describe('setOrgFeatures caps', () => {
    it('student → ForbiddenError', async () => {
      await expect(
        setOrgFeaturesWithDb(env.db, makeSession(env.orgAId, env.userAId, 'student'), {
          features: { billing: false },
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('renter → ForbiddenError', async () => {
      await expect(
        setOrgFeaturesWithDb(env.db, makeSession(env.orgAId, env.userAId, 'renter'), {
          features: { billing: false },
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('null session → UnauthenticatedError', async () => {
      await expect(setOrgFeaturesWithDb(env.db, null, { features: { billing: false } })).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    });

    it('owner → OK (a same-value call is a harmless no-op, no row created yet)', async () => {
      const result = await setOrgFeaturesWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), {
        operatingMode: 'school',
      });
      expect(result).toEqual({ ok: true, operatingMode: 'school', features: ALL_MODULES_ENABLED });
      // Still no audit row — this was a no-op (matches the pre-mutation default state).
      expect(await countFeatureAuditRows(env.db, env.orgAId)).toBe(0);
    });
  });

  // ── APPLY PRESET ──────────────────────────────────────────────────────────

  describe('applyPreset', () => {
    it('operatingMode:"club" + applyPreset:true persists the club preset + ONE audit row', async () => {
      const sess = makeSession(env.orgAId, env.userAId, 'owner');
      const before = await countFeatureAuditRows(env.db, env.orgAId);

      const result = await setOrgFeaturesWithDb(env.db, sess, { operatingMode: 'club', applyPreset: true });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.operatingMode).toBe('club');
        expect(result.features).toEqual(OPERATING_MODE_PRESETS.club);
        expect(result.features.training).toBe(false);
        expect(result.features.booking).toBe(false);
        expect(result.features.auto_schedule).toBe(false);
        expect(result.features.maintenance).toBe(true);
        expect(result.features.billing).toBe(true);
        expect(result.features.portal).toBe(true);
        expect(result.features.reports).toBe(true);
        expect(result.features.messages).toBe(true);
      }

      // Re-read confirms persistence.
      const view = await getOrgFeaturesWithDb(env.db, sess);
      expect(view.operatingMode).toBe('club');
      expect(view.features).toEqual(OPERATING_MODE_PRESETS.club);

      const after = await countFeatureAuditRows(env.db, env.orgAId);
      expect(after).toBe(before + 1);
    });
  });

  // ── PARTIAL PATCH ─────────────────────────────────────────────────────────

  describe('partial patch', () => {
    it('{ features: { billing:false } } flips only billing; mode + other flags unchanged', async () => {
      const sess = makeSession(env.orgAId, env.userAId, 'owner');
      const result = await setOrgFeaturesWithDb(env.db, sess, { features: { billing: false } });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.operatingMode).toBe('club'); // unchanged from the applyPreset test
        expect(result.features.billing).toBe(false);
        expect(result.features.training).toBe(false); // unchanged (club preset)
        expect(result.features.booking).toBe(false); // unchanged (club preset)
        expect(result.features.auto_schedule).toBe(false); // unchanged (club preset)
        expect(result.features.maintenance).toBe(true); // unchanged
        expect(result.features.portal).toBe(true); // unchanged
        expect(result.features.reports).toBe(true); // unchanged
        expect(result.features.messages).toBe(true); // unchanged
      }
    });
  });

  // ── NO-OP WRITE ───────────────────────────────────────────────────────────

  describe('no-op write', () => {
    it('writing the exact current state writes NO new audit row', async () => {
      const sess = makeSession(env.orgAId, env.userAId, 'owner');
      const before = await countFeatureAuditRows(env.db, env.orgAId);

      // Current state: club mode, billing:false (from the previous two tests),
      // every other flag = the club preset value. Re-send that exact shape.
      const result = await setOrgFeaturesWithDb(env.db, sess, {
        operatingMode: 'club',
        features: {
          training: false,
          maintenance: true,
          billing: false,
          booking: false,
          portal: true,
          reports: true,
          auto_schedule: false,
          messages: true,
        },
      });
      expect(result.ok).toBe(true);

      const after = await countFeatureAuditRows(env.db, env.orgAId);
      expect(after).toBe(before);
    });
  });

  // ── T-ISO ─────────────────────────────────────────────────────────────────

  describe('T-ISO', () => {
    it('org A club-mode + billing:false changes are invisible to org B', async () => {
      const bView = await getOrgFeaturesWithDb(env.db, makeSession(env.orgBId, env.userBId, 'owner'));
      expect(bView.operatingMode).toBe('school');
      expect(bView.features).toEqual(ALL_MODULES_ENABLED);
    });
  });

  // ── VALIDATION ────────────────────────────────────────────────────────────

  describe('validation', () => {
    it('empty input {} (neither operatingMode nor features) → ValidationError', async () => {
      const sess = makeSession(env.orgAId, env.userAId, 'owner');
      await expect(setOrgFeaturesWithDb(env.db, sess, {})).rejects.toBeInstanceOf(ValidationError);
    });

    it('applyPreset:true without operatingMode → ValidationError', async () => {
      const sess = makeSession(env.orgAId, env.userAId, 'owner');
      await expect(setOrgFeaturesWithDb(env.db, sess, { applyPreset: true })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  // ── SEARCH GATING ─────────────────────────────────────────────────────────
  // Org A has training:false (club mode, set above). Org B still has the
  // all-enabled default. Owner has training:access on BOTH orgs — the group's
  // absence for org A is the module flag, not the capability.

  describe('search gating (training)', () => {
    it('org A (training:false): a seeded course never surfaces in search results', async () => {
      const title = 'GatedCourseZQ9';
      await insCourse(env.db, env.orgAId, title, env.userAId);

      const sess = makeSession(env.orgAId, env.userAId, 'owner');
      const result = await searchOrgWithDb(env.db, sess, { query: title });
      expect(result.groups.find((g) => g.type === 'course')).toBeUndefined();
    });

    it('org B (training:true, default): an equivalent seeded course DOES surface', async () => {
      const title = 'UngatedCourseZQ9';
      await insCourse(env.db, env.orgBId, title, env.userBId);

      const sess = makeSession(env.orgBId, env.userBId, 'owner');
      const result = await searchOrgWithDb(env.db, sess, { query: title });
      const group = result.groups.find((g) => g.type === 'course');
      expect(group).toBeDefined();
      expect(group?.results.some((r) => r.primary === title)).toBe(true);
    });
  });

  // ── BOOKING GATE ──────────────────────────────────────────────────────────
  // Org A has booking:false (club mode, set above). Org B still has booking:true.

  describe('booking gate', () => {
    it('org A (booking:false): submitBookingRequestWithDb refuses, no row inserted', async () => {
      const before = await countBookingRequests(env.db, env.orgAId);

      const result = await submitBookingRequestWithDb(env.db, 'alpha', minimalBookingPayload());
      expect(result).toEqual({ ok: false, reason: 'unavailable' });

      const after = await countBookingRequests(env.db, env.orgAId);
      expect(after).toBe(before);
    });

    it('org B (booking:true, default): submitBookingRequestWithDb accepts and inserts a row', async () => {
      const before = await countBookingRequests(env.db, env.orgBId);

      const result = await submitBookingRequestWithDb(env.db, 'beta', minimalBookingPayload({ email: 'bob@example.com' }));
      expect(result).toEqual({ ok: true });

      const after = await countBookingRequests(env.db, env.orgBId);
      expect(after).toBe(before + 1);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// envAbsent — GRACEFUL ABSENCE (migration 0047 NOT applied; only 0046)
// ════════════════════════════════════════════════════════════════════════════

describe('org features — graceful absence (migration 0047 NOT applied)', () => {
  let env: TestEnv;

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL_0046);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    env = { db, pglite, orgAId: seed.orgAId, orgBId: seed.orgBId, userAId: seed.userAId, userBId: seed.userBId };
  }, 120_000);

  it('getOrgFeatures → available:false, "school", all 8 modules true', async () => {
    const view = await getOrgFeaturesWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'));
    expect(view.available).toBe(false);
    expect(view.operatingMode).toBe('school');
    expect(view.features).toEqual(ALL_MODULES_ENABLED);
  });

  it('setOrgFeatures → { ok:false, reason:"not_available" }', async () => {
    const result = await setOrgFeaturesWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), {
      operatingMode: 'club',
      applyPreset: true,
    });
    expect(result).toEqual({ ok: false, reason: 'not_available' });
  });

  it('booking submit is unaffected (booking still defaults to enabled)', async () => {
    const before = await countBookingRequests(env.db, env.orgAId);
    const result = await submitBookingRequestWithDb(env.db, 'alpha', minimalBookingPayload({ email: 'absence@example.com' }));
    expect(result).toEqual({ ok: true });
    const after = await countBookingRequests(env.db, env.orgAId);
    expect(after).toBe(before + 1);
  });
});
