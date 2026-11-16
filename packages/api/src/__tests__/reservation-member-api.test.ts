/**
 * reservation-member-api.test.ts — the member a booking is FOR
 * (reservation.member_user_id, migration 0051) on the scheduling write + read
 * paths. pglite + *WithDb forms; every migration through 0051.
 *
 * Renters and students cannot book, so club staff book for them; memberUserId
 * names the member. These pin:
 *
 *   CREATE   — createReservation stores it (created_by stays the staff
 *              member), returns it, audits it; a create that names no one is
 *              unchanged (NULL, no new key on the result or the audit row).
 *   REFUSE   — another org's user, a deactivated member, a user with no
 *              membership, an unknown or malformed id → ValidationError, and
 *              nothing is written.
 *   SERIES   — createSeries puts it on every occurrence and on the
 *              series.created audit row; a bad member writes no series at all.
 *   MOVE     — rescheduleReservation keeps it on the new row; a member
 *              deactivated since the booking refuses the move and leaves the
 *              original booked.
 *   READ     — listReservations / listSeriesOccurrences return memberUserId +
 *              memberDisplayName (full name, else e-mail), RLS-scoped.
 *   PICKER   — listBookingMembers: the org's ACTIVE members only, gated on
 *              schedule:create_reservation (a CFI may; a renter may not).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { and, eq, sql } from 'drizzle-orm';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  seedUserWithoutMembership,
  loadMigrationSql,
  appUser,
  membership,
  auditLog,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { createSeriesWithDb } from '../scheduling/create-series.js';
import { rescheduleReservationWithDb } from '../scheduling/reschedule-reservation.js';
import { listReservationsWithDb } from '../scheduling/list-reservations.js';
import { listSeriesOccurrencesWithDb } from '../scheduling/list-series-occurrences.js';
import { listBookingMembersWithDb } from '../scheduling/list-booking-members.js';
import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';
import { extractRows } from '../db-rows.js';

const MIGRATION_SQL = loadMigrationSql('0051');

function makeSession(orgId: string, userId: string, role: AppSession['role'] = 'owner'): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

/** One UTC hour on a fixed future day (no booking policy here, so any day books). */
const at = (day: number, hour: number) => new Date(Date.UTC(2031, 0, day, hour, 0, 0));

interface Env {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  ownerAId: string;
  ownerBId: string;
  cfiAId: string;
  /** Active org-A renter the bookings are for ("Riley Member"). */
  rileyId: string;
  /** Active org-A renter with no full name (display name falls back to e-mail). */
  noNameId: string;
  /** Deactivated org-A renter. */
  inactiveId: string;
  /** Org-A user with no membership row. */
  noMembershipId: string;
  /** Active org-B renter. */
  orgBMemberId: string;
}

let env: Env;

async function seedMember(
  db: PgliteTestClient,
  orgId: string,
  email: string,
  role: AppSession['role'],
  opts: { fullName?: string | null; status?: 'active' | 'inactive' } = {},
): Promise<string> {
  return withOrgContext(db, orgId, async (tx) => {
    const [usr] = await tx
      .insert(appUser)
      .values({
        orgId,
        email,
        fullName: opts.fullName === undefined ? `User ${email}` : opts.fullName,
        status: opts.status ?? 'active',
      })
      .returning();
    await tx.insert(membership).values({ orgId, userId: usr!.id, role });
    return usr!.id;
  });
}

async function newAircraft(orgId: string, tail: string): Promise<string> {
  const r = await createResourceWithDb(env.db, makeSession(orgId, env.ownerAId, 'owner'), {
    kind: 'aircraft',
    displayName: `Aircraft ${tail}`,
    tailNumber: tail,
  });
  return r.id;
}

/** The reservation.created audit rows for one reservation (org A). */
async function createdAudit(reservationId: string) {
  return withOrgContext(env.db, env.orgAId, (tx) =>
    tx
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'reservation.created'), eq(auditLog.entityId, reservationId))),
  );
}

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
    ownerAId: seed.userAId,
    ownerBId: seed.userBId,
    cfiAId: '',
    rileyId: '',
    noNameId: '',
    inactiveId: '',
    noMembershipId: '',
    orgBMemberId: '',
  };
  env.cfiAId = await seedMember(db, seed.orgAId, 'cfi@alpha.example', 'cfi');
  env.rileyId = await seedMember(db, seed.orgAId, 'riley@alpha.example', 'renter', { fullName: 'Riley Member' });
  env.noNameId = await seedMember(db, seed.orgAId, 'noname@alpha.example', 'student', { fullName: null });
  env.inactiveId = await seedMember(db, seed.orgAId, 'gone@alpha.example', 'renter', { status: 'inactive' });
  env.noMembershipId = (await seedUserWithoutMembership(db, seed.orgAId, 'nomember@alpha.example')).id;
  env.orgBMemberId = await seedMember(db, seed.orgBId, 'member@beta.example', 'renter');
}, 90_000);

// ════════════════════════════════════════════════════════════════════════════
// CREATE
// ════════════════════════════════════════════════════════════════════════════

describe('CREATE — createReservation with memberUserId', () => {
  it('stores the member (created_by stays the booker), returns it, and lists the name', async () => {
    const aircraftId = await newAircraft(env.orgAId, 'NMEM01');
    const owner = makeSession(env.orgAId, env.ownerAId, 'owner');
    const r = await createReservationWithDb(env.db, owner, {
      startAt: at(5, 9), endAt: at(5, 11), resourceIds: [aircraftId],
      notes: 'Riley — club currency flight', memberUserId: env.rileyId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reservation.createdBy).toBe(env.ownerAId);
    expect(r.reservation.memberUserId).toBe(env.rileyId);

    const rows = await listReservationsWithDb(env.db, owner, { from: at(5, 0), to: at(6, 0) });
    const row = rows.find((x) => x.id === r.reservation.id);
    expect(row?.memberUserId).toBe(env.rileyId);
    expect(row?.memberDisplayName).toBe('Riley Member');
    expect(row?.createdBy).toBe(env.ownerAId);
  });

  it('puts memberUserId in the reservation.created audit metadata', async () => {
    const aircraftId = await newAircraft(env.orgAId, 'NMEM02');
    const r = await createReservationWithDb(env.db, makeSession(env.orgAId, env.ownerAId, 'owner'), {
      startAt: at(6, 9), endAt: at(6, 10), resourceIds: [aircraftId], memberUserId: env.rileyId,
    });
    if (!r.ok) throw new Error(r.reason);
    const audit = await createdAudit(r.reservation.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ memberUserId: env.rileyId, resourceIds: [aircraftId] });
  });

  it('a CFI (schedule:create_reservation) can book for a member too', async () => {
    const aircraftId = await newAircraft(env.orgAId, 'NMEM03');
    const r = await createReservationWithDb(env.db, makeSession(env.orgAId, env.cfiAId, 'cfi'), {
      startAt: at(7, 9), endAt: at(7, 10), resourceIds: [aircraftId], memberUserId: env.rileyId,
    });
    expect(r.ok && r.reservation.memberUserId).toBe(env.rileyId);
  });

  it('the display name falls back to the e-mail when the member has no full name', async () => {
    const aircraftId = await newAircraft(env.orgAId, 'NMEM04');
    const owner = makeSession(env.orgAId, env.ownerAId, 'owner');
    const r = await createReservationWithDb(env.db, owner, {
      startAt: at(8, 9), endAt: at(8, 10), resourceIds: [aircraftId], memberUserId: env.noNameId,
    });
    if (!r.ok) throw new Error(r.reason);
    const rows = await listReservationsWithDb(env.db, owner, { from: at(8, 0), to: at(9, 0) });
    expect(rows.find((x) => x.id === r.reservation.id)?.memberDisplayName).toBe('noname@alpha.example');
  });

  it('no member (absent or null) → NULL, and neither the result nor the audit row grows a key', async () => {
    const aircraftId = await newAircraft(env.orgAId, 'NMEM05');
    const owner = makeSession(env.orgAId, env.ownerAId, 'owner');
    const absent = await createReservationWithDb(env.db, owner, {
      startAt: at(9, 9), endAt: at(9, 10), resourceIds: [aircraftId],
    });
    const asNull = await createReservationWithDb(env.db, owner, {
      startAt: at(9, 11), endAt: at(9, 12), resourceIds: [aircraftId], memberUserId: null,
    });
    for (const r of [absent, asNull]) {
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect('memberUserId' in r.reservation).toBe(false);
      const audit = await createdAudit(r.reservation.id);
      expect(Object.keys(audit[0]!.metadata as object).sort()).toEqual(['endAt', 'resourceIds', 'startAt']);
    }
    const rows = await listReservationsWithDb(env.db, owner, { from: at(9, 0), to: at(10, 0) });
    const mine = rows.filter((x) => x.resourceIds.includes(aircraftId));
    expect(mine).toHaveLength(2);
    for (const row of mine) {
      expect(row.memberUserId).toBeNull();
      expect(row.memberDisplayName).toBeNull();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REFUSE
// ════════════════════════════════════════════════════════════════════════════

describe('REFUSE — memberUserId must be an active member of this org', () => {
  const cases: Array<[string, () => string]> = [
    ["another org's member", () => env.orgBMemberId],
    ['a deactivated member', () => env.inactiveId],
    ['a user with no membership row', () => env.noMembershipId],
    ['an unknown id', () => '00000000-0000-4000-8000-000000000000'],
  ];

  for (const [i, [label, memberId]] of cases.entries()) {
    it(`${label} → ValidationError, nothing written`, async () => {
      const aircraftId = await newAircraft(env.orgAId, `NREF0${i}`);
      const owner = makeSession(env.orgAId, env.ownerAId, 'owner');
      await expect(
        createReservationWithDb(env.db, owner, {
          startAt: at(12, 9), endAt: at(12, 10), resourceIds: [aircraftId], memberUserId: memberId(),
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      const rows = await listReservationsWithDb(env.db, owner, { from: at(12, 0), to: at(13, 0) });
      expect(rows.filter((x) => x.resourceIds.includes(aircraftId))).toEqual([]);
    });
  }

  it('a malformed id → ValidationError before any data access', async () => {
    await expect(
      createReservationWithDb(env.db, makeSession(env.orgAId, env.ownerAId, 'owner'), {
        startAt: at(13, 9), endAt: at(13, 10),
        resourceIds: ['00000000-0000-4000-8000-000000000001'], memberUserId: 'riley',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SERIES
// ════════════════════════════════════════════════════════════════════════════

describe('SERIES — createSeries with memberUserId', () => {
  // Pinned clock: the weekly rule expands from this instant.
  const NOW = Date.UTC(2031, 1, 2, 0, 0, 0); // Sun 2031-02-02

  it('every occurrence is for the member; series.created and each reservation.created audit it', async () => {
    const aircraftId = await newAircraft(env.orgAId, 'NSER01');
    const owner = makeSession(env.orgAId, env.ownerAId, 'owner');
    const result = await createSeriesWithDb(env.db, owner, {
      weekdays: [2, 4], intervalWeeks: 1, end: { kind: 'count', count: 4 },
      localStartTime: '17:00', durationMinutes: 90, tz: 'UTC',
      resourceIds: [aircraftId], notes: 'Riley — lesson block', memberUserId: env.rileyId,
    }, { now: NOW });
    expect(result.skippedCount).toBe(0);
    expect(result.createdCount).toBeGreaterThanOrEqual(2);

    const listed = await listSeriesOccurrencesWithDb(env.db, owner, { seriesId: result.series.id });
    if (!listed.ok) throw new Error('series not found');
    expect(listed.occurrences).toHaveLength(result.createdCount);
    for (const occ of listed.occurrences) {
      expect(occ.memberUserId).toBe(env.rileyId);
      expect(occ.memberDisplayName).toBe('Riley Member');
    }

    const seriesAudit = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select({ metadata: auditLog.metadata }).from(auditLog)
        .where(and(eq(auditLog.action, 'series.created'), eq(auditLog.entityId, result.series.id))),
    );
    expect(seriesAudit[0]!.metadata).toMatchObject({ memberUserId: env.rileyId });
    for (const occ of listed.occurrences) {
      expect((await createdAudit(occ.id))[0]!.metadata).toMatchObject({
        memberUserId: env.rileyId, seriesId: result.series.id,
      });
    }
  });

  it('a member of another org → ValidationError and no series row at all', async () => {
    const aircraftId = await newAircraft(env.orgAId, 'NSER02');
    const owner = makeSession(env.orgAId, env.ownerAId, 'owner');
    await expect(
      createSeriesWithDb(env.db, owner, {
        weekdays: [3], intervalWeeks: 1, end: { kind: 'count', count: 2 },
        localStartTime: '08:00', durationMinutes: 60, tz: 'UTC',
        resourceIds: [aircraftId], notes: 'refused-series-member', memberUserId: env.orgBMemberId,
      }, { now: NOW }),
    ).rejects.toBeInstanceOf(ValidationError);
    const series = await withOrgContext(env.db, env.orgAId, async (tx) =>
      extractRows<{ n: number }>(await tx.execute(sql`
        SELECT count(*)::int AS n FROM reservation_series
         WHERE org_id = ${env.orgAId}::uuid AND notes = 'refused-series-member'`)),
    );
    expect(series[0]!.n).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MOVE
// ════════════════════════════════════════════════════════════════════════════

describe('MOVE — rescheduleReservation keeps the member', () => {
  it('the new row is for the same member; the original is cancelled', async () => {
    const aircraftId = await newAircraft(env.orgAId, 'NMOV01');
    const owner = makeSession(env.orgAId, env.ownerAId, 'owner');
    const r = await createReservationWithDb(env.db, owner, {
      startAt: at(20, 9), endAt: at(20, 10), resourceIds: [aircraftId], memberUserId: env.rileyId,
    });
    if (!r.ok) throw new Error(r.reason);
    const moved = await rescheduleReservationWithDb(env.db, owner, {
      reservationId: r.reservation.id, newStartAt: at(20, 14), newEndAt: at(20, 15),
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.reservation.memberUserId).toBe(env.rileyId);

    const rows = await listReservationsWithDb(env.db, owner, {
      from: at(20, 0), to: at(21, 0), includeCancelled: true,
    });
    const newRow = rows.find((x) => x.id === moved.reservation.id);
    const oldRow = rows.find((x) => x.id === r.reservation.id);
    expect(newRow?.memberUserId).toBe(env.rileyId);
    expect(newRow?.memberDisplayName).toBe('Riley Member');
    expect(oldRow?.status).toBe('cancelled');
    expect((await createdAudit(moved.reservation.id))[0]!.metadata).toMatchObject({ memberUserId: env.rileyId });
  });

  it('a booking for no one stays for no one when moved', async () => {
    const aircraftId = await newAircraft(env.orgAId, 'NMOV02');
    const owner = makeSession(env.orgAId, env.ownerAId, 'owner');
    const r = await createReservationWithDb(env.db, owner, {
      startAt: at(21, 9), endAt: at(21, 10), resourceIds: [aircraftId],
    });
    if (!r.ok) throw new Error(r.reason);
    const moved = await rescheduleReservationWithDb(env.db, owner, {
      reservationId: r.reservation.id, newStartAt: at(21, 12), newEndAt: at(21, 13),
    });
    if (!moved.ok) throw new Error(moved.reason);
    expect('memberUserId' in moved.reservation).toBe(false);
    const rows = await listReservationsWithDb(env.db, owner, { from: at(21, 0), to: at(22, 0) });
    expect(rows.find((x) => x.id === moved.reservation.id)?.memberUserId).toBeNull();
  });

  it('a member deactivated since the booking refuses the move; the original stays booked', async () => {
    const leaverId = await seedMember(env.db, env.orgAId, `leaver-${Date.now()}@alpha.example`, 'renter');
    const aircraftId = await newAircraft(env.orgAId, 'NMOV03');
    const owner = makeSession(env.orgAId, env.ownerAId, 'owner');
    const r = await createReservationWithDb(env.db, owner, {
      startAt: at(22, 9), endAt: at(22, 10), resourceIds: [aircraftId], memberUserId: leaverId,
    });
    if (!r.ok) throw new Error(r.reason);
    await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.update(appUser).set({ status: 'inactive' }).where(eq(appUser.id, leaverId)),
    );

    await expect(
      rescheduleReservationWithDb(env.db, owner, {
        reservationId: r.reservation.id, newStartAt: at(22, 12), newEndAt: at(22, 13),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const rows = await listReservationsWithDb(env.db, owner, { from: at(22, 0), to: at(23, 0) });
    const original = rows.find((x) => x.id === r.reservation.id);
    expect(original?.status).toBe('booked');
    expect(original?.memberUserId).toBe(leaverId);
    expect(rows.filter((x) => x.resourceIds.includes(aircraftId))).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// READ isolation
// ════════════════════════════════════════════════════════════════════════════

describe('READ — another org never sees the booking or its member', () => {
  it("org B's schedule for the same day holds none of org A's member bookings", async () => {
    const rows = await listReservationsWithDb(
      env.db, makeSession(env.orgBId, env.ownerBId, 'owner'),
      { from: at(5, 0), to: at(23, 0) },
    );
    expect(rows.some((x) => x.memberUserId === env.rileyId)).toBe(false);
    expect(rows.some((x) => x.memberDisplayName === 'Riley Member')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PICKER
// ════════════════════════════════════════════════════════════════════════════

describe('PICKER — listBookingMembers', () => {
  it("lists the org's active members only, by name", async () => {
    const rows = await listBookingMembersWithDb(env.db, makeSession(env.orgAId, env.ownerAId, 'owner'));
    const ids = rows.map((r) => r.userId);
    expect(ids).toContain(env.rileyId);
    expect(ids).toContain(env.ownerAId);
    expect(ids).toContain(env.noNameId);
    expect(ids).not.toContain(env.inactiveId);
    expect(ids).not.toContain(env.noMembershipId);
    expect(ids).not.toContain(env.orgBMemberId);
    expect(rows.find((r) => r.userId === env.rileyId)).toEqual({
      userId: env.rileyId, displayName: 'Riley Member', role: 'renter',
    });
    expect(rows.find((r) => r.userId === env.noNameId)?.displayName).toBe('noname@alpha.example');
  });

  it('is open to every role that can book (cfi) and closed to the rest', async () => {
    await expect(listBookingMembersWithDb(env.db, makeSession(env.orgAId, env.cfiAId, 'cfi')))
      .resolves.toBeDefined();
    for (const role of ['renter', 'student', 'mechanic', 'accountant'] as const) {
      await expect(listBookingMembersWithDb(env.db, makeSession(env.orgAId, env.rileyId, role)))
        .rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(listBookingMembersWithDb(env.db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});
