/**
 * calendar-api.test.ts — Integration tests for Slice P1.4: iCal /
 * subscribable calendar feeds.
 *
 * Applies migrations 0000–0028. Every write goes through the REAL
 * createCalendarFeedWithDb / revokeCalendarFeedWithDb /
 * regenerateCalendarFeedWithDb / createResourceWithDb / createReservationWithDb
 * — no bespoke SQL bypasses the command layer (except two direct fixture
 * inserts documented at each call site: a second app_user for isolation
 * testing, and one dispatch_ticket row to exercise the "dispatched pilot"
 * predicate without going through the full openDispatch gate).
 *
 * COVERAGE:
 *   1. createCalendarFeed: token shape, upsert-or-return-existing,
 *      per-scope capability gating (app:access vs fleet:access), aircraft
 *      not_found (unknown resource AND cross-org resource).
 *   2. resolveFeedByToken: crosses the pre-context boundary (no session/org
 *      GUC needed to call it); unknown token → null; revoked token → null
 *      (indistinguishable from unknown).
 *   3. buildIcsForFeed('my_reservations'): T-ISO + intra-org self-scope —
 *      a member's feed contains ONLY their own (booker OR dispatched-pilot)
 *      reservations; never another member's, never another org's.
 *   4. buildIcsForFeed('aircraft'): contains exactly that tail's in-window
 *      reservations (from any booker), never another org's.
 *   5. listMyCalendarFeeds: self-scoped (own feeds only).
 *   6. revokeCalendarFeed: self-owned lookup — cross-user revoke attempt is
 *      refused as not_found (not a leak of "exists but isn't yours").
 *   7. regenerateCalendarFeed: atomic revoke-old + create-new; old token
 *      stops resolving, new token resolves to the same scope/resource.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  appUser,
  dispatchTicket,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';
import type { PGlite } from '@electric-sql/pglite';

import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { createCalendarFeedWithDb } from '../calendar/create-calendar-feed.js';
import { listMyCalendarFeedsWithDb } from '../calendar/list-my-calendar-feeds.js';
import {
  revokeCalendarFeedWithDb,
  regenerateCalendarFeedWithDb,
} from '../calendar/revoke-calendar-feed.js';
import { resolveFeedByToken } from '../calendar/resolve-feed.js';
import { buildIcsForFeed } from '../calendar/build-ics-for-feed.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// ── Path resolution ───────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function migrationSql(name: string): string {
  return readFileSync(resolve(__dirname, `../../../db/migrations/${name}`), 'utf-8');
}

const MIGRATION_SQL = [
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
  // 0037 required: resource now includes category/aircraft_class (Slice P2-LOG2).
  // Drizzle ORM INSERT on resource emits all columns, so the columns must exist.
  migrationSql('0037_logbook_annotation.sql'),
  migrationSql('0038_stage_check_enforcement.sql'),
];

// ── Shared test environment ───────────────────────────────────────────────────

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;   // org A, role owner — the booker of resAUserA
  userBId: string;   // org B, role owner
  memberA2Id: string; // org A, a SECOND member — the booker of resAMemberA2
  resourceAId: string;
  resourceBId: string;
  resAUserAId: string;   // org A reservation booked by userA, pilot memberA2
  resAMemberA2Id: string; // org A reservation booked by memberA2
  resBUserBId: string;   // org B reservation booked by userB
}

function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'] = 'owner',
): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

let env: TestEnv;

// Anchor "now" for every window/DTSTAMP check — far enough in the future to
// be deterministic and inside a realistic [now-7d, now+90d) reading window.
const NOW = new Date('2026-07-15T12:00:00.000Z');
const RES_A_USERA = { from: new Date('2026-07-20T14:00:00.000Z'), to: new Date('2026-07-20T16:00:00.000Z') };
const RES_A_MEMBERA2 = { from: new Date('2026-07-21T14:00:00.000Z'), to: new Date('2026-07-21T16:00:00.000Z') };
const RES_B_USERB = { from: new Date('2026-07-20T14:00:00.000Z'), to: new Date('2026-07-20T16:00:00.000Z') };

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });

  const orgAId = seed.orgAId;
  const orgBId = seed.orgBId;
  const userAId = seed.userAId;
  const userBId = seed.userBId;

  const sessA = makeSession(orgAId, userAId, 'owner');
  const sessB = makeSession(orgBId, userBId, 'owner');

  // A second member in org A, for intra-org self-scope isolation testing.
  // Direct insert (mirrors import-api.test.ts's seedExistingMember pattern) —
  // a fixture, not a code path under test.
  const memberA2Rows = await withOrgContext(db, orgAId, (tx) =>
    tx.insert(appUser).values({ orgId: orgAId, email: 'member2@alpha.example', fullName: 'Member Two' }).returning(),
  );
  const memberA2Id = memberA2Rows[0]!.id;
  // NOTE: 'cfi' here is ONLY so this fixture booking call has
  // schedule:create_reservation (needed to seed resAMemberA2). Every actual
  // TEST below constructs its own session for memberA2Id with whatever role
  // the assertion needs (e.g. 'renter' to test the app:access-only /
  // fleet:access-denied paths) — role is a per-call session claim, not tied
  // to a stored membership row in these *WithDb tests.
  const sessA2 = makeSession(orgAId, memberA2Id, 'cfi');

  const resA = await createResourceWithDb(db, sessA, {
    kind: 'aircraft',
    displayName: 'Alpha Air N111AA',
    tailNumber: 'N111AA',
  });
  const resB = await createResourceWithDb(db, sessB, {
    kind: 'aircraft',
    displayName: 'Beta Air N222BB',
    tailNumber: 'N222BB',
  });

  const resAUserA = await createReservationWithDb(db, sessA, {
    resourceIds: [resA.id],
    startAt: RES_A_USERA.from,
    endAt: RES_A_USERA.to,
    notes: 'Org A, booked by owner',
  });
  if (!resAUserA.ok) throw new Error(`resAUserA seed failed: ${resAUserA.reason}`);

  const resAMemberA2 = await createReservationWithDb(db, sessA2, {
    resourceIds: [resA.id],
    startAt: RES_A_MEMBERA2.from,
    endAt: RES_A_MEMBERA2.to,
    notes: 'Org A, booked by member two',
  });
  if (!resAMemberA2.ok) throw new Error(`resAMemberA2 seed failed: ${resAMemberA2.reason}`);

  const resBUserB = await createReservationWithDb(db, sessB, {
    resourceIds: [resB.id],
    startAt: RES_B_USERB.from,
    endAt: RES_B_USERB.to,
    notes: 'Org B, booked by owner',
  });
  if (!resBUserB.ok) throw new Error(`resBUserB seed failed: ${resBUserB.reason}`);

  // Fixture: a dispatch_ticket linking memberA2 as PILOT on resAUserA (which
  // memberA2 did NOT book) — exercises the "dispatched pilot" branch of
  // readCalendarEventsForUser. Direct insert (bypasses the full openDispatch
  // gate) — this test targets the calendar-feed read, not the dispatch gate.
  await withOrgContext(db, orgAId, (tx) =>
    tx.insert(dispatchTicket).values({
      orgId: orgAId,
      reservationId: resAUserA.reservation.id,
      resourceId: resA.id,
      pilotUserId: memberA2Id,
      status: 'open',
      hobbsOut: '0.0',
      tachOut: '0.0',
      openedBy: userAId,
    }),
  );

  env = {
    db,
    pglite,
    orgAId,
    orgBId,
    userAId,
    userBId,
    memberA2Id,
    resourceAId: resA.id,
    resourceBId: resB.id,
    resAUserAId: resAUserA.reservation.id,
    resAMemberA2Id: resAMemberA2.reservation.id,
    resBUserBId: resBUserB.reservation.id,
  };
}, 120_000);

// ════════════════════════════════════════════════════════════════════════════════
// 1. createCalendarFeed
// ════════════════════════════════════════════════════════════════════════════════

describe('1. createCalendarFeed', () => {
  it('1a. my_reservations: mints a long, unique, base64url token', async () => {
    const sessA2 = makeSession(env.orgAId, env.memberA2Id, 'renter');
    const result = await createCalendarFeedWithDb(env.db, sessA2, { scope: 'my_reservations' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.scope).toBe('my_reservations');
    expect(result.feed.resourceId).toBeNull();
    expect(result.feed.active).toBe(true);
    expect(result.feed.feedToken.length).toBeGreaterThanOrEqual(40);
    expect(/^[A-Za-z0-9_-]+$/.test(result.feed.feedToken)).toBe(true);
  });

  it('1b. my_reservations: a second call returns the SAME existing active feed (upsert-or-return)', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const first = await createCalendarFeedWithDb(env.db, sessA, { scope: 'my_reservations' });
    const second = await createCalendarFeedWithDb(env.db, sessA, { scope: 'my_reservations' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.feed.id).toBe(first.feed.id);
    expect(second.feed.feedToken).toBe(first.feed.feedToken);
  });

  it('1c. my_reservations: allowed for a role with only app:access+portal:access (renter)', async () => {
    const sessRenter = makeSession(env.orgBId, env.userBId, 'renter');
    const result = await createCalendarFeedWithDb(env.db, sessRenter, { scope: 'my_reservations' });
    expect(result.ok).toBe(true);
  });

  it('1d. aircraft: owner (fleet:access) can create a feed for an org-owned aircraft', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await createCalendarFeedWithDb(env.db, sessA, {
      scope: 'aircraft',
      resourceId: env.resourceAId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.scope).toBe('aircraft');
    expect(result.feed.resourceId).toBe(env.resourceAId);
  });

  it('1e. aircraft: unknown resourceId → not_found', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await createCalendarFeedWithDb(env.db, sessA, {
      scope: 'aircraft',
      resourceId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });

  it('1f. aircraft: a resource belonging to ANOTHER org → not_found (tenant isolation)', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await createCalendarFeedWithDb(env.db, sessA, {
      scope: 'aircraft',
      resourceId: env.resourceBId, // org B's aircraft
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });

  it('1g. aircraft: a role WITHOUT fleet:access (renter) is refused', async () => {
    const sessRenter = makeSession(env.orgAId, env.memberA2Id, 'renter');
    await expect(
      createCalendarFeedWithDb(env.db, sessRenter, { scope: 'aircraft', resourceId: env.resourceAId }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2. resolveFeedByToken — the pre-context boundary
// ════════════════════════════════════════════════════════════════════════════════

describe('2. resolveFeedByToken', () => {
  it('2a. resolves a known active token WITHOUT any prior session/org context', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const created = await createCalendarFeedWithDb(env.db, sessA, { scope: 'my_reservations' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Called directly — no withOrgContext / session wraps this call. If this
    // resolves, the pre-context (platform-admin) read path works.
    const resolved = await resolveFeedByToken(env.db, created.feed.feedToken);
    expect(resolved).not.toBeNull();
    expect(resolved?.orgId).toBe(env.orgAId);
    expect(resolved?.userId).toBe(env.userAId);
    expect(resolved?.scope).toBe('my_reservations');
    expect(resolved?.resourceId).toBeNull();
  });

  it('2b. unknown token → null', async () => {
    const resolved = await resolveFeedByToken(env.db, 'this-token-does-not-exist-anywhere');
    expect(resolved).toBeNull();
  });

  it('2c. a revoked token → null (indistinguishable from unknown)', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const created = await createCalendarFeedWithDb(env.db, sessA, {
      scope: 'aircraft',
      resourceId: env.resourceAId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const revoked = await revokeCalendarFeedWithDb(env.db, sessA, { feedId: created.feed.id });
    expect(revoked.ok).toBe(true);

    const resolved = await resolveFeedByToken(env.db, created.feed.feedToken);
    expect(resolved).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3. buildIcsForFeed('my_reservations') — T-ISO + intra-org self-scope
// ════════════════════════════════════════════════════════════════════════════════

describe("3. buildIcsForFeed('my_reservations')", () => {
  it('3a. userA sees own booked reservation, NOT memberA2\'s reservation, NOT org B\'s', async () => {
    const feed = { id: 'n/a', orgId: env.orgAId, userId: env.userAId, scope: 'my_reservations' as const, resourceId: null };
    const ics = await buildIcsForFeed(env.db, feed, NOW);

    expect(ics).toContain(`UID:aeroops-reservation-${env.resAUserAId}@aeroops.app`);
    expect(ics).not.toContain(`UID:aeroops-reservation-${env.resAMemberA2Id}@aeroops.app`);
    expect(ics).not.toContain(`UID:aeroops-reservation-${env.resBUserBId}@aeroops.app`);
  });

  it('3b. memberA2 sees own booked reservation AND the one they are dispatched pilot on, NOT org B\'s', async () => {
    const feed = { id: 'n/a', orgId: env.orgAId, userId: env.memberA2Id, scope: 'my_reservations' as const, resourceId: null };
    const ics = await buildIcsForFeed(env.db, feed, NOW);

    // Own booking.
    expect(ics).toContain(`UID:aeroops-reservation-${env.resAMemberA2Id}@aeroops.app`);
    // Dispatched-pilot inclusion (booked by userA, memberA2 is the pilot).
    expect(ics).toContain(`UID:aeroops-reservation-${env.resAUserAId}@aeroops.app`);
    // Never org B's.
    expect(ics).not.toContain(`UID:aeroops-reservation-${env.resBUserBId}@aeroops.app`);
  });

  it('3c. userB (org B) sees ONLY org B\'s reservation — never org A\'s, even with the same window', async () => {
    const feed = { id: 'n/a', orgId: env.orgBId, userId: env.userBId, scope: 'my_reservations' as const, resourceId: null };
    const ics = await buildIcsForFeed(env.db, feed, NOW);

    expect(ics).toContain(`UID:aeroops-reservation-${env.resBUserBId}@aeroops.app`);
    expect(ics).not.toContain(`UID:aeroops-reservation-${env.resAUserAId}@aeroops.app`);
    expect(ics).not.toContain(`UID:aeroops-reservation-${env.resAMemberA2Id}@aeroops.app`);
  });

  it('3d. produces a well-formed VCALENDAR (structural sanity)', async () => {
    const feed = { id: 'n/a', orgId: env.orgAId, userId: env.userAId, scope: 'my_reservations' as const, resourceId: null };
    const ics = await buildIcsForFeed(env.db, feed, NOW);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('SUMMARY:Reservation — N111AA\r\n');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4. buildIcsForFeed('aircraft')
// ════════════════════════════════════════════════════════════════════════════════

describe("4. buildIcsForFeed('aircraft')", () => {
  it('4a. resourceA feed contains BOTH resA reservations (any booker), never org B\'s', async () => {
    const feed = { id: 'n/a', orgId: env.orgAId, userId: env.userAId, scope: 'aircraft' as const, resourceId: env.resourceAId };
    const ics = await buildIcsForFeed(env.db, feed, NOW);

    expect(ics).toContain(`UID:aeroops-reservation-${env.resAUserAId}@aeroops.app`);
    expect(ics).toContain(`UID:aeroops-reservation-${env.resAMemberA2Id}@aeroops.app`);
    expect(ics).not.toContain(`UID:aeroops-reservation-${env.resBUserBId}@aeroops.app`);
    expect(ics).toContain('SUMMARY:N111AA — Reserved\r\n');
  });

  it('4b. resourceB feed contains ONLY resB\'s reservation', async () => {
    const feed = { id: 'n/a', orgId: env.orgBId, userId: env.userBId, scope: 'aircraft' as const, resourceId: env.resourceBId };
    const ics = await buildIcsForFeed(env.db, feed, NOW);

    expect(ics).toContain(`UID:aeroops-reservation-${env.resBUserBId}@aeroops.app`);
    expect(ics).not.toContain(`UID:aeroops-reservation-${env.resAUserAId}@aeroops.app`);
    expect(ics).not.toContain(`UID:aeroops-reservation-${env.resAMemberA2Id}@aeroops.app`);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5. listMyCalendarFeeds — self-scoped
// ════════════════════════════════════════════════════════════════════════════════

describe('5. listMyCalendarFeeds', () => {
  it('5a. returns only the caller\'s OWN feeds, not another member\'s', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const sessA2 = makeSession(env.orgAId, env.memberA2Id, 'renter');

    const userAFeeds = await listMyCalendarFeedsWithDb(env.db, sessA);
    const memberA2Feeds = await listMyCalendarFeedsWithDb(env.db, sessA2);

    expect(userAFeeds.length).toBeGreaterThan(0);
    expect(memberA2Feeds.length).toBeGreaterThan(0);

    const userAIds = new Set(userAFeeds.map((f) => f.id));
    const memberA2Ids = new Set(memberA2Feeds.map((f) => f.id));
    for (const id of memberA2Ids) {
      expect(userAIds.has(id)).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 6. revokeCalendarFeed — self-owned lookup
// ════════════════════════════════════════════════════════════════════════════════

describe('6. revokeCalendarFeed', () => {
  it('6a. owner revokes their own feed → active=false', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const created = await createCalendarFeedWithDb(env.db, sessA, {
      scope: 'aircraft',
      resourceId: env.resourceAId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await revokeCalendarFeedWithDb(env.db, sessA, { feedId: created.feed.id });
    expect(result.ok).toBe(true);

    const feeds = await listMyCalendarFeedsWithDb(env.db, sessA);
    const revoked = feeds.find((f) => f.id === created.feed.id);
    expect(revoked?.active).toBe(false);
  });

  it("6b. a DIFFERENT member cannot revoke another member's feed — not_found, not a leak", async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const sessA2 = makeSession(env.orgAId, env.memberA2Id, 'renter');

    const created = await createCalendarFeedWithDb(env.db, sessA, { scope: 'my_reservations' });
    // (may already exist from an earlier test — either way it's userA's, ok:true)
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await revokeCalendarFeedWithDb(env.db, sessA2, { feedId: created.feed.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');

    // Confirm it's still active — the cross-user attempt had NO effect.
    const feeds = await listMyCalendarFeedsWithDb(env.db, sessA);
    const stillThere = feeds.find((f) => f.id === created.feed.id);
    expect(stillThere?.active).toBe(true);
  });

  it('6c. revoking an unknown feedId → not_found', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await revokeCalendarFeedWithDb(env.db, sessA, {
      feedId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 7. regenerateCalendarFeed — atomic revoke-old + create-new
// ════════════════════════════════════════════════════════════════════════════════

describe('7. regenerateCalendarFeed', () => {
  it('7a. old token stops resolving; new token resolves to the same scope/resource', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const created = await createCalendarFeedWithDb(env.db, sessA, {
      scope: 'aircraft',
      resourceId: env.resourceAId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const oldToken = created.feed.feedToken;

    const regenerated = await regenerateCalendarFeedWithDb(env.db, sessA, { feedId: created.feed.id });
    expect(regenerated.ok).toBe(true);
    if (!regenerated.ok) return;

    expect(regenerated.feed.feedToken).not.toBe(oldToken);
    expect(regenerated.feed.scope).toBe('aircraft');
    expect(regenerated.feed.resourceId).toBe(env.resourceAId);
    expect(regenerated.feed.id).not.toBe(created.feed.id);

    const oldResolved = await resolveFeedByToken(env.db, oldToken);
    expect(oldResolved).toBeNull();

    const newResolved = await resolveFeedByToken(env.db, regenerated.feed.feedToken);
    expect(newResolved).not.toBeNull();
    expect(newResolved?.resourceId).toBe(env.resourceAId);
  });

  it('7b. regenerating an unknown/not-owned feedId → not_found', async () => {
    const sessA2 = makeSession(env.orgAId, env.memberA2Id, 'renter');
    const result = await regenerateCalendarFeedWithDb(env.db, sessA2, {
      feedId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });
});
