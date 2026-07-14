/**
 * avatar.test.ts — the profile-photo API surface (Slice AVATARS, migration 0048).
 *
 * Two PGlite environments:
 *   env0048 — migrations 0000–0048 applied (avatar_data column present).
 *   envAbsent — migrations 0000–0047 (0048 absent → GRACEFUL ABSENCE:
 *               reads return available:false + null, writes return not_available).
 *
 * COVERAGE: caps; self vs staff writes; the security-load-bearing data-URI
 * validation (only base64 png/jpeg/webp; svg/javascript/oversized refused);
 * tenant isolation on the batch read + the staff update; audit never carries
 * image bytes; graceful absence.
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
  loadMigrationSql,
} from '@aeroops/db';
import { and, eq } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import {
  getMyAvatarWithDb,
  setMyAvatarWithDb,
  getMemberAvatarsWithDb,
  updateMemberAvatarWithDb,
} from '../people/avatar.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import { ValidationError } from '../scheduling/internal.js';
import type { AppSession } from '../auth/types.js';

const MIGRATION_SQL_0048 = loadMigrationSql('0048');
const MIGRATION_SQL_0047 = loadMigrationSql('0047');

// A minimal valid 1x1 PNG (transparent) as a data URI.
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

interface Env {
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

describe('avatars (migration 0048 applied)', () => {
  let env: Env;

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL_0048);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    env = { db, pglite, orgAId: seed.orgAId, orgBId: seed.orgBId, userAId: seed.userAId, userBId: seed.userBId };
  }, 120_000);

  it('getMyAvatar requires a session (app:access)', async () => {
    await expect(getMyAvatarWithDb(env.db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('setMyAvatar sets then clears the caller own photo; audit carries no bytes', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    const set = await setMyAvatarWithDb(env.db, sess, { avatarDataUrl: PNG_1x1 });
    expect(set).toEqual({ ok: true });

    const read = await getMyAvatarWithDb(env.db, sess);
    expect(read.available).toBe(true);
    expect(read.avatarDataUrl).toBe(PNG_1x1);

    // The audit row records that a photo is set, NEVER the image bytes.
    const audits = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.orgId, env.orgAId), eq(auditLog.action, 'people.avatar_changed'), eq(auditLog.entityId, env.userAId))),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audits[audits.length - 1]?.metadata)).not.toContain('base64');

    const cleared = await setMyAvatarWithDb(env.db, sess, { avatarDataUrl: null });
    expect(cleared).toEqual({ ok: true });
    expect((await getMyAvatarWithDb(env.db, sess)).avatarDataUrl).toBeNull();
  });

  it('rejects non-image and oversized data URIs (the security gate)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const svg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
    const js = 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==';
    const notBase64 = 'data:image/png;base64,<script>alert(1)</script>';
    const oversized = 'data:image/png;base64,' + 'A'.repeat(200_000);
    for (const bad of [svg, js, notBase64, oversized]) {
      await expect(setMyAvatarWithDb(env.db, sess, { avatarDataUrl: bad })).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('updateMemberAvatar requires people:manage; a renter cannot set another member photo', async () => {
    const renter = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(
      updateMemberAvatarWithDb(env.db, renter, { memberUserId: env.userAId, avatarDataUrl: PNG_1x1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('T-ISO: staff cannot set an avatar on a member of another org', async () => {
    const ownerA = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await updateMemberAvatarWithDb(env.db, ownerA, { memberUserId: env.userBId, avatarDataUrl: PNG_1x1 });
    // orgB's user is invisible under orgA's RLS scope → member_not_found, never a write.
    expect(r).toEqual({ ok: false, reason: 'member_not_found' });
  });

  it('T-ISO: batch read only returns this org member photos', async () => {
    const ownerA = makeSession(env.orgAId, env.userAId, 'owner');
    await updateMemberAvatarWithDb(env.db, ownerA, { memberUserId: env.userAId, avatarDataUrl: PNG_1x1 });
    const res = await getMemberAvatarsWithDb(env.db, ownerA, { userIds: [env.userAId, env.userBId] });
    const byId = new Map(res.avatars.map((a) => [a.userId, a.avatarDataUrl]));
    expect(byId.get(env.userAId)).toBe(PNG_1x1);
    // orgB user is outside orgA's RLS scope → null, never orgB's data.
    expect(byId.get(env.userBId)).toBeNull();
  });
});

describe('avatars — graceful absence (migration 0048 NOT applied)', () => {
  let env: Env;

  beforeAll(async () => {
    const { db, pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, MIGRATION_SQL_0047);
    const seed = await seedTwoOrgs(db);
    await setTestAppRole({ pglite });
    env = { db, pglite, orgAId: seed.orgAId, orgBId: seed.orgBId, userAId: seed.userAId, userBId: seed.userBId };
  }, 120_000);

  it('getMyAvatar ⇒ available:false, null', async () => {
    const r = await getMyAvatarWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'));
    expect(r).toEqual({ avatarDataUrl: null, available: false });
  });

  it('setMyAvatar ⇒ not_available', async () => {
    const r = await setMyAvatarWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), {
      avatarDataUrl: PNG_1x1,
    });
    expect(r).toEqual({ ok: false, reason: 'not_available' });
  });

  it('getMemberAvatars ⇒ available:false with null photos', async () => {
    const r = await getMemberAvatarsWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'), {
      userIds: [env.userAId],
    });
    expect(r.available).toBe(false);
    expect(r.avatars).toEqual([{ userId: env.userAId, avatarDataUrl: null }]);
  });
});
