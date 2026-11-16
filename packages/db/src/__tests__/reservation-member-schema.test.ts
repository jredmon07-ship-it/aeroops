/**
 * reservation-member-schema.test.ts — Schema tests for
 * 0051_reservation_member.sql (the member a booking is FOR).
 *
 * Proves:
 *   M1. reservation.member_user_id exists: uuid, nullable, no default. A
 *       reservation that names no member keeps it NULL (existing inserts,
 *       which never name the column, are unchanged).
 *   M2. The composite FK (member_user_id, org_id) → app_user(id, org_id)
 *       REFUSES a member of another org (23503) — even as the superuser,
 *       where RLS does not apply.
 *   M3. It accepts a member of the booking's own org, through the Drizzle
 *       schema object (memberUserId).
 *   M4. ON DELETE SET NULL ("member_user_id"): deleting the member's user row
 *       nulls member_user_id alone; the booking survives with its org_id and
 *       status intact.
 *   M5. The partial index (org_id, member_user_id) WHERE member_user_id IS NOT
 *       NULL exists.
 *   M6. RLS + grants: as aeroops_app, org A reads and updates member_user_id on
 *       its own booking (the table-level grant from 0002 covers the new column);
 *       org B's context sees none of org A's bookings; GUC unset → 0 rows.
 *   M7. The down migration removes the column, the FK and the index, and the
 *       up migration re-applies cleanly after it.
 *
 * Test harness: PGlite (in-process Postgres WASM) with every real up
 * migration applied in order (the shared loader), so the SQL validated here
 * is the exact production artifact. NEVER applied to a real DB.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import {
  createTestClient,
  applyMigrationSql,
  loadMigrationSql,
  withOrgContext,
  withPlatformAdminContext,
} from '../index.js';
import { org, appUser, reservation } from '../schema/index.js';
import type { PgliteTestClient } from '../client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const UP_0051 = readFileSync(
  resolve(__dirname, '../../migrations/0051_reservation_member.sql'),
  'utf-8',
);
const DOWN_0051 = readFileSync(
  resolve(__dirname, '../../migrations/0051_reservation_member.down.sql'),
  'utf-8',
);

const START = '2030-03-01T10:00:00Z';
const END = '2030-03-01T12:00:00Z';

interface Env {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  /** Org A staff member: created_by on every org-A booking here. */
  staffAId: string;
  /** Org A member the bookings are for. */
  memberAId: string;
  /** Org B user: never a valid member of an org-A booking. */
  userBId: string;
}

async function setup(): Promise<Env> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, loadMigrationSql());

  // Seeding runs as the PGlite superuser; the org GUC is still set so the
  // RLS WITH CHECK policies are exercised.
  const [orgA, orgB] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx.insert(org).values({ name: 'Alpha School', slug: 'alpha-member' }).returning();
    const b = await tx.insert(org).values({ name: 'Beta Club', slug: 'beta-member' }).returning();
    return [a[0]!, b[0]!];
  });

  const [staffA, memberA] = await withOrgContext(db, orgA.id, async (tx) => {
    const s = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'staff@alpha.example', fullName: 'Sam Staff' })
      .returning();
    const m = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'riley@alpha.example', fullName: 'Riley Member' })
      .returning();
    return [s[0]!, m[0]!];
  });

  const [userB] = await withOrgContext(db, orgB.id, async (tx) =>
    tx
      .insert(appUser)
      .values({ orgId: orgB.id, email: 'bob@beta.example', fullName: 'Bob B' })
      .returning(),
  );

  return {
    db,
    pglite,
    orgAId: orgA.id,
    orgBId: orgB.id,
    staffAId: staffA.id,
    memberAId: memberA.id,
    userBId: userB!.id,
  };
}

/** Raw INSERT of an org-A booking inside an org-scoped transaction. */
async function insertBooking(
  pglite: PGlite,
  orgId: string,
  createdBy: string,
  memberUserId: string | null,
): Promise<string> {
  await pglite.exec('BEGIN');
  try {
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgId}'`);
    const res = await pglite.query<{ id: string }>(
      `INSERT INTO reservation (org_id, start_at, end_at, created_by, member_user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [orgId, START, END, createdBy, memberUserId],
    );
    await pglite.exec('COMMIT');
    return res.rows[0]!.id;
  } catch (err) {
    await pglite.exec('ROLLBACK');
    throw err;
  }
}

describe('0051 reservation.member_user_id (the member a booking is for)', () => {
  let env: Env;

  beforeAll(async () => {
    env = await setup();
  });

  it('M1: member_user_id is a nullable uuid with no default; a booking naming no member keeps it NULL', async () => {
    const { pglite, orgAId, staffAId } = env;
    const col = await pglite.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'reservation' AND column_name = 'member_user_id'`,
    );
    expect(col.rows).toEqual([{ data_type: 'uuid', is_nullable: 'YES', column_default: null }]);

    // The pre-0051 INSERT shape (no member_user_id column named) still works.
    await pglite.exec('BEGIN');
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const res = await pglite.query<{ member_user_id: string | null }>(
      `INSERT INTO reservation (org_id, start_at, end_at, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING member_user_id`,
      [orgAId, START, END, staffAId],
    );
    await pglite.exec('COMMIT');
    expect(res.rows[0]!.member_user_id).toBeNull();
  });

  it('M2: the FK refuses a member of another org (23503), even for the superuser', async () => {
    const { pglite, orgAId, staffAId, userBId } = env;
    await expect(insertBooking(pglite, orgAId, staffAId, userBId)).rejects.toMatchObject({
      code: '23503',
      constraint: 'reservation_member_user_id_org_fk',
    });
    // Nothing was written for that attempt.
    const rows = await pglite.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM reservation WHERE member_user_id = $1`,
      [userBId],
    );
    expect(rows.rows[0]!.n).toBe(0);
  });

  it('M3: the FK accepts a member of the booking\'s own org (Drizzle memberUserId)', async () => {
    const { db, orgAId, staffAId, memberAId } = env;
    const [row] = await withOrgContext(db, orgAId, (tx) =>
      tx
        .insert(reservation)
        .values({
          orgId: orgAId,
          startAt: new Date(START),
          endAt: new Date(END),
          createdBy: staffAId,
          memberUserId: memberAId,
        })
        .returning({ id: reservation.id, memberUserId: reservation.memberUserId }),
    );
    expect(row!.memberUserId).toBe(memberAId);
  });

  it('M4: deleting the member nulls member_user_id alone; the booking survives', async () => {
    const { pglite, db, orgAId, staffAId } = env;
    const [leaver] = await withOrgContext(db, orgAId, (tx) =>
      tx
        .insert(appUser)
        .values({ orgId: orgAId, email: 'leaver@alpha.example', fullName: 'Lee Leaver' })
        .returning(),
    );
    const bookingId = await insertBooking(pglite, orgAId, staffAId, leaver!.id);

    await pglite.exec('BEGIN');
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await pglite.query(`DELETE FROM app_user WHERE id = $1`, [leaver!.id]);
    await pglite.exec('COMMIT');

    const after = await pglite.query<{ member_user_id: string | null; org_id: string; status: string }>(
      `SELECT member_user_id, org_id, status FROM reservation WHERE id = $1`,
      [bookingId],
    );
    expect(after.rows).toEqual([{ member_user_id: null, org_id: orgAId, status: 'booked' }]);
  });

  it('M5: the partial index on (org_id, member_user_id) skips NULL rows', async () => {
    const { pglite } = env;
    const idx = await pglite.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'reservation' AND indexname = 'reservation_org_id_member_user_id_idx'`,
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0]!.indexdef).toMatch(/\(org_id, member_user_id\)/);
    expect(idx.rows[0]!.indexdef).toMatch(/WHERE \(member_user_id IS NOT NULL\)/);
  });

  it('M6: as aeroops_app, RLS scopes member_user_id to its org and the grant covers the column', async () => {
    const { pglite, db, orgAId, orgBId, staffAId, memberAId } = env;
    const bookingId = await insertBooking(pglite, orgAId, staffAId, memberAId);

    await pglite.exec('SET ROLE aeroops_app');
    try {
      // Org A reads the column on its own booking …
      const mine = await withOrgContext(db, orgAId, (tx) =>
        tx
          .select({ memberUserId: reservation.memberUserId })
          .from(reservation)
          .where(eq(reservation.id, bookingId)),
      );
      expect(mine).toEqual([{ memberUserId: memberAId }]);

      // … and may change it (UPDATE privilege on the new column).
      const cleared = await withOrgContext(db, orgAId, (tx) =>
        tx
          .update(reservation)
          .set({ memberUserId: null })
          .where(eq(reservation.id, bookingId))
          .returning({ memberUserId: reservation.memberUserId }),
      );
      expect(cleared).toEqual([{ memberUserId: null }]);

      // Org B sees none of org A's bookings.
      const theirs = await withOrgContext(db, orgBId, (tx) =>
        tx.select({ id: reservation.id }).from(reservation).where(eq(reservation.id, bookingId)),
      );
      expect(theirs).toEqual([]);

      // GUC unset → FORCE RLS fails closed.
      const none = await pglite.query<{ n: number }>(`SELECT count(*)::int AS n FROM reservation`);
      expect(none.rows[0]!.n).toBe(0);
    } finally {
      await pglite.exec('SET ROLE postgres');
    }
  });
});

describe('0051 down migration', () => {
  it('M7: removes the column, FK and index; the up migration re-applies after it', async () => {
    const { pglite } = await createTestClient();
    await applyMigrationSql({ pglite }, loadMigrationSql());

    await applyMigrationSql({ pglite }, DOWN_0051);
    const col = await pglite.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'reservation' AND column_name = 'member_user_id'`,
    );
    expect(col.rows).toHaveLength(0);
    const fk = await pglite.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'reservation_member_user_id_org_fk'`,
    );
    expect(fk.rows).toHaveLength(0);
    const idx = await pglite.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'reservation_org_id_member_user_id_idx'`,
    );
    expect(idx.rows).toHaveLength(0);

    await applyMigrationSql({ pglite }, UP_0051);
    const back = await pglite.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'reservation_member_user_id_org_fk'`,
    );
    expect(back.rows).toHaveLength(1);
  });
});
