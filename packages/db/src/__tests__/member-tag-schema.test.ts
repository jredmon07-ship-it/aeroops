/**
 * member-tag-schema.test.ts — Schema tests for 0008_people.sql (Slice 6.1).
 *
 * Proves spec §5 T1–T8:
 *   T1. Additive app_user INSERT omitting phone/status back-fills status='active'
 *       and phone=NULL — existing inserts continue to succeed unchanged.
 *   T2. app_user_status_check rejects a bad status value (e.g. 'banned').
 *   T3. member_tag RLS isolation: org A cannot see org B's member_tag rows.
 *       FORCE RLS fail-closed: GUC unset → 0 rows.
 *   T4. member_tag_user_org_fk (user_id, org_id) composite FK blocks a tag
 *       that references a user from a different org (cross-org user_id).
 *   T5. member_tag_user_id_tag_unique UNIQUE (user_id, tag) — duplicate tag for
 *       the same user is rejected; same tag on a different user is accepted.
 *   T6. member_tag_tag_nonempty_check — empty string rejected; blank-only rejected.
 *   T7. CASCADE from app_user: deleting a tagged user removes their member_tag rows.
 *   T8. RESTRICT on created_by: deleting a user who authored a tag is blocked.
 *       Down migration cleanly reverses: member_tag table gone, status/phone
 *       columns gone from app_user.
 *
 * Test harness: PGlite (in-process Postgres WASM). Applies all nine real
 * migration artifacts (0000–0008) in order so the constraint SQL validated
 * here is the exact production artifact. NEVER applied to a real DB.
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
import { org, appUser, memberTag } from '../schema/index.js';
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
];

const DOWN_0008 = readFileSync(
  resolve(__dirname, '../../migrations/0008_people.down.sql'),
  'utf-8',
);

// ── Test environment ──────────────────────────────────────────────────────────

interface MemberTagTestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;   // member of org A (the tagged user)
  userA2Id: string;  // second member of org A (creator)
  userBId: string;   // member of org B
}

async function setupMemberTagEnv(): Promise<MemberTagTestEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const [orgA, orgB] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx
      .insert(org)
      .values({ name: 'Alpha Flight School', slug: 'alpha-tag' })
      .returning();
    const b = await tx
      .insert(org)
      .values({ name: 'Beta Club', slug: 'beta-tag' })
      .returning();
    return [a[0]!, b[0]!];
  });

  const [userA, userA2] = await withOrgContext(db, orgA.id, async (tx) => {
    const u1 = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'alice@alpha.example', fullName: 'Alice A' })
      .returning();
    const u2 = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'admin@alpha.example', fullName: 'Admin A' })
      .returning();
    return [u1[0]!, u2[0]!];
  });

  const [userB] = await withOrgContext(db, orgB.id, async (tx) => {
    const u = await tx
      .insert(appUser)
      .values({ orgId: orgB.id, email: 'bob@beta.example', fullName: 'Bob B' })
      .returning();
    return [u[0]!];
  });

  // Drop to aeroops_app for RLS enforcement on all subsequent queries.
  await setTestAppRole({ pglite });

  return {
    db,
    pglite,
    orgAId: orgA.id,
    orgBId: orgB.id,
    userAId: userA.id,
    userA2Id: userA2.id,
    userBId: userB.id,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Inserts a valid member_tag row for an org.
 * Caller must set GUC before calling (BEGIN + SET LOCAL recommended).
 * Returns the new tag id.
 */
async function insertTag(
  pglite: PGlite,
  orgId: string,
  userId: string,
  createdBy: string,
  tag: string,
): Promise<string> {
  const result = await pglite.query<{ id: string }>(
    `INSERT INTO member_tag (org_id, user_id, tag, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [orgId, userId, tag, createdBy],
  );
  return result.rows[0]!.id;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('member-tag-schema: migration 0008 + constraints + RLS', () => {
  let env: MemberTagTestEnv;

  beforeAll(async () => {
    env = await setupMemberTagEnv();
  });

  // ── T1: Additive app_user insert back-fills status='active' ──────────────

  it('T1: app_user INSERT omitting phone/status back-fills status="active" and phone=NULL', async () => {
    const { pglite, orgAId } = env;

    // Insert as superuser (no RLS restriction on insert for this check).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const result = await pglite.query<{ status: string; phone: string | null }>(
      `INSERT INTO app_user (org_id, email, full_name)
       VALUES ($1, 'backfill@alpha.example', 'Backfill User')
       RETURNING status, phone`,
      [orgAId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(result.rows[0]!.status).toBe('active');
    expect(result.rows[0]!.phone).toBeNull();
  });

  // ── T2: app_user_status_check rejects bad status value ───────────────────

  it('T2: app_user_status_check rejects an invalid status value', async () => {
    const { pglite, orgAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO app_user (org_id, email, full_name, status)
         VALUES ($1, 'banned@alpha.example', 'Banned User', 'banned')`,
        [orgAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── T3: member_tag RLS isolation ─────────────────────────────────────────

  it('T3a: member_tag table exists after migration 0008', async () => {
    const { pglite } = env;
    const result = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'member_tag'
       ) AS exists`,
    );
    expect(result.rows[0]!.exists).toBe(true);
  });

  it('T3b: FORCE RLS fail-closed — GUC unset → 0 rows from member_tag', async () => {
    const { pglite } = env;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const result = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM member_tag`,
    );
    expect(result.rows[0]!.count).toBe('0');
  });

  it('T3c: RLS isolation — org A cannot see org B member_tag rows', async () => {
    const { pglite, db, orgAId, orgBId, userAId, userA2Id, userBId } = env;

    // Seed a tag for org A as superuser.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertTag(pglite, orgAId, userAId, userA2Id, 'student');
    await pglite.exec(`COMMIT`);

    // Seed a tag for org B as superuser.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await insertTag(pglite, orgBId, userBId, userBId, 'renter');
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Org A context — must not see org B rows.
    const rowsUnderA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(memberTag).execute(),
    );
    expect(rowsUnderA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsUnderA.some((r) => r.orgId === orgBId)).toBe(false);

    // Org B context — must see org B rows, not org A rows.
    const rowsUnderB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(memberTag).execute(),
    );
    expect(rowsUnderB.every((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsUnderB.some((r) => r.orgId === orgAId)).toBe(false);
  });

  // ── T4: (user_id, org_id) composite FK blocks cross-org user ─────────────

  it('T4: member_tag_user_org_fk rejects a tag referencing a user from a different org', async () => {
    const { pglite, orgAId, userBId, userA2Id } = env;
    // Tag in org A but user_id belongs to org B — must fail FK check.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertTag(pglite, orgAId, userBId, userA2Id, 'cross-org-tag'),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── T5: (user_id, tag) UNIQUE ────────────────────────────────────────────

  it('T5a: member_tag_user_id_tag_unique — duplicate (user_id, tag) is rejected', async () => {
    const { pglite, orgAId, userAId, userA2Id } = env;
    // First insert succeeds.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertTag(pglite, orgAId, userAId, userA2Id, 'cfi');
    await pglite.exec(`COMMIT`);

    // Second insert with the same user_id + tag must fail.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertTag(pglite, orgAId, userAId, userA2Id, 'cfi'),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T5b: member_tag_user_id_tag_unique — same tag on a different user is accepted', async () => {
    const { pglite, orgAId, userAId, userA2Id } = env;
    // Insert 'instructor' on userA2Id — different user, same tag value is OK.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const id = await insertTag(pglite, orgAId, userA2Id, userAId, 'instructor');
    await pglite.exec(`COMMIT`);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── T6: member_tag_tag_nonempty_check ────────────────────────────────────

  it('T6a: member_tag_tag_nonempty_check — empty string tag is rejected', async () => {
    const { pglite, orgAId, userAId, userA2Id } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertTag(pglite, orgAId, userAId, userA2Id, ''),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T6b: member_tag_tag_nonempty_check — blank-only (spaces) tag is rejected', async () => {
    const { pglite, orgAId, userAId, userA2Id } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertTag(pglite, orgAId, userAId, userA2Id, '   '),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── T7: CASCADE from app_user ─────────────────────────────────────────────

  it('T7: CASCADE — deleting a tagged user removes their member_tag rows', async () => {
    const { pglite, orgAId, userA2Id } = env;

    // Create a disposable user and tag them — as superuser.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const newUserResult = await pglite.query<{ id: string }>(
      `INSERT INTO app_user (org_id, email, full_name)
       VALUES ($1, 'disposable@alpha.example', 'Disposable')
       RETURNING id`,
      [orgAId],
    );
    const disposableUserId = newUserResult.rows[0]!.id;
    const tagResult = await pglite.query<{ id: string }>(
      `INSERT INTO member_tag (org_id, user_id, tag, created_by)
       VALUES ($1, $2, 'cascade-test', $3)
       RETURNING id`,
      [orgAId, disposableUserId, userA2Id],
    );
    const tagId = tagResult.rows[0]!.id;
    await pglite.exec(`COMMIT`);

    // Delete the user — their tags must cascade-delete.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await pglite.query(`DELETE FROM app_user WHERE id = $1`, [disposableUserId]);
    await pglite.exec(`COMMIT`);

    // Verify the tag is gone.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const check = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM member_tag WHERE id = $1`,
      [tagId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(check.rows[0]!.count).toBe('0');
  });

  // ── T8a: RESTRICT on created_by ───────────────────────────────────────────

  it('T8a: RESTRICT — deleting a user who authored a tag is blocked', async () => {
    const { pglite, orgAId, userAId } = env;

    // Create a disposable creator and insert a tag they authored — as superuser.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const creatorResult = await pglite.query<{ id: string }>(
      `INSERT INTO app_user (org_id, email, full_name)
       VALUES ($1, 'creator-restrict@alpha.example', 'Creator Restrict')
       RETURNING id`,
      [orgAId],
    );
    const creatorId = creatorResult.rows[0]!.id;
    // Tag is on userAId, authored by creatorId.
    await pglite.query(
      `INSERT INTO member_tag (org_id, user_id, tag, created_by)
       VALUES ($1, $2, 'restrict-test', $3)`,
      [orgAId, userAId, creatorId],
    );
    await pglite.exec(`COMMIT`);

    // Attempt to delete the creator — must fail (RESTRICT).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(`DELETE FROM app_user WHERE id = $1`, [creatorId]),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── T8b: Down migration reverses 0008 ────────────────────────────────────

  it('T8b: down migration cleanly reverses 0008 — member_tag gone, status/phone columns gone', async () => {
    // Spin up a fresh DB, apply all migrations, then run down.
    const { pglite: pg2 } = await createTestClient();
    await applyMigrationSql({ pglite: pg2 }, MIGRATION_SQL);
    await applyMigrationSql({ pglite: pg2 }, [DOWN_0008]);

    // member_tag table should be gone.
    const tableCheck = await pg2.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'member_tag'
       ) AS exists`,
    );
    expect(tableCheck.rows[0]!.exists).toBe(false);

    // app_user.status column should be gone.
    const statusCheck = await pg2.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM information_schema.columns
       WHERE table_name = 'app_user' AND column_name = 'status'`,
    );
    expect(statusCheck.rows[0]!.count).toBe('0');

    // app_user.phone column should be gone.
    const phoneCheck = await pg2.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM information_schema.columns
       WHERE table_name = 'app_user' AND column_name = 'phone'`,
    );
    expect(phoneCheck.rows[0]!.count).toBe('0');

    // app_user_status_check constraint should be gone.
    const constraintCheck = await pg2.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_constraint
       WHERE conrelid = 'app_user'::regclass
         AND conname = 'app_user_status_check'`,
    );
    expect(constraintCheck.rows[0]!.count).toBe('0');
  });
});
