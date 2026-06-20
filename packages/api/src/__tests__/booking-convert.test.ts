/**
 * booking-convert.test.ts — Slice PB2.1b convertBookingRequest integration tests.
 * pglite + *WithDb forms; migrations 0000–0016; two seeded orgs.
 *
 * COVERAGE:
 *
 * HEADLINE — routes through the FROZEN gatedCreateOccurrence (NO bespoke INSERT):
 *   STRUCT-1  convert-booking-request.ts contains NO `insert(reservation` / raw
 *             reservation INSERT (the source-level proof the gate is the only path).
 *   ROUTE-1   a success creates a reservation with created_by = the STAFF session
 *             user + the reservation.created audit metadata.bookingRequestId set.
 *
 * SUCCESS — atomic convert:
 *   OK-1   reservation created + request flipped to 'converted' + link set both ways.
 *   OK-2   ONE booking_request.converted audit row (ids-only metadata, NO PII).
 *   OK-3   derived notes contain requester name + email; NO app_user row created.
 *
 * REFUSAL — atomic per gate (NO reservation written; request STILL new/contacted,
 *           link NULL, handled_at unchanged; ZERO convert audit rows):
 *   REF-conflict       seed a competing booked window → reason:'conflict'.
 *   REF-policy         max-duration policy block → reason:'policy'.
 *   REF-twilight       twilight block mode + night window → reason:'twilight'.
 *   REF-availability   availability block mode + out-of-hours → reason:'availability'.
 *
 * IDEMPOTENCY / CONCURRENCY:
 *   IDEM-1  re-convert an already-converted request → not_convertible.
 *   IDEM-2  convert a declined request → not_convertible.
 *   CONC-1  two PARALLEL converts of the same request → exactly ONE reservation,
 *           the loser → not_convertible (FOR UPDATE serializes).
 *
 * T-ISO — tenant isolation:
 *   ISO-1  org A converts org B's request id → not_found, no write.
 *   ISO-2  org A converts using org B's resourceId → ValidationError, no write.
 *
 * CAP — capability enforcement (BOTH caps, in order):
 *   CAP-1  owner/manager/dispatcher succeed (both caps).
 *   CAP-2  cfi (has schedule:create_reservation, LACKS booking:triage) → Forbidden
 *          on the FIRST check (booking:triage).
 *   CAP-3  accountant (LACKS both) → Forbidden on the first check.
 *   CAP-4  null session → UnauthenticatedError.
 *
 * VALIDATION:
 *   VAL-1  bad uuid → ValidationError.
 *   VAL-2  endAt <= startAt → ValidationError.
 *
 * WARN — warn-mode passthrough (still converts, warnings ride along):
 *   WARN-1  twilight warn-mode night window → ok:true + twilightWarnings, converted.
 *
 * MONEY — NO money anywhere (balance seam OFF; no price/dollar in result/audit).
 *   (implicit across all tests — no money fields exist; verified by shape.)
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
} from '@aeroops/db';
import {
  location,
  dispatchConfig,
  reservation,
  resource,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { computeSolarEvents } from '@aeroops/core';
import type { MembershipRole } from '@aeroops/core';

import {
  convertBookingRequestWithDb,
  createReservationWithDb,
  createResourceWithDb,
  upsertBookingPolicyWithDb,
  createAvailabilityWindowWithDb,
  listBookingRequestsWithDb,
} from '../index.js';
import { UnauthenticatedError, ForbiddenError } from '../auth/index.js';
import { ValidationError } from '../scheduling/internal.js';
import type { AppSession } from '../auth/types.js';

// ── Path resolution + migrations 0000–0016 ─────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_SQL = [
  readFileSync(resolve(__dirname, '../../../db/migrations/0000_loud_prodigy.sql'),      'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0001_auth_credential.sql'),   'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0002_scheduling.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0003_booking_policies.sql'),  'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0004_recurrence.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0005_dispatch.sql'),          'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0006_squawks_grounding.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0007_fleet.sql'),             'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0008_people.sql'),            'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0009_dispatch_gate.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0010_civil_twilight.sql'),    'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0011_optimizer_run.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0012_training.sql'),          'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0013_work_orders.sql'),       'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0014_availability.sql'),      'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0015_booking_request.sql'),   'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0016_booking_request_convert.sql'), 'utf-8'),
];

// ── Twilight fixture (mid-latitude, fixed civil day) ───────────────────────────
const LAT = 33.9425;
const LON = -118.4081;
const DAY_ANCHOR = Date.parse('2026-06-19T20:00:00Z');
const solar = computeSolarEvents({ latitude: LAT, longitude: LON, dateUtcMs: DAY_ANCHOR });
if (solar.classification !== 'normal' || solar.civilDuskUtcMs === null) {
  throw new Error('test fixture: expected a normal civil day with a dusk boundary');
}
const DUSK = solar.civilDuskUtcMs;
const DAWN = solar.civilDawnUtcMs!;
// Daylight window (no twilight crossing).
const DAY_START = new Date(DAWN + 60 * 60_000);
const DAY_END = new Date(DAWN + 120 * 60_000);
// Night-crossing window (crosses civil dusk).
const NIGHT_START = new Date(DUSK - 30 * 60_000);
const NIGHT_END = new Date(DUSK + 30 * 60_000);

// ── Test env ───────────────────────────────────────────────────────────────────

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  locationAId: string;
  locationBId: string;
  userAId: string;
  userBId: string;
}

let env: TestEnv;

function makeSession(orgId: string, userId: string, role: MembershipRole = 'owner'): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'staff@test.example' } };
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

let tailCounter = 0;
function uniqueTail(): string {
  tailCounter += 1;
  return `NC${String(tailCounter).padStart(4, '0')}`;
}

async function mkAircraft(orgId: string, userId: string, homeBaseLocationId?: string): Promise<string> {
  const sess = makeSession(orgId, userId);
  const ac = await createResourceWithDb(env.db, sess, {
    kind: 'aircraft',
    displayName: `N-${uniqueTail()}`,
    tailNumber: uniqueTail(),
  });
  if (homeBaseLocationId) {
    await withOrgContext(env.db, orgId, async (tx) => {
      await tx
        .update(resource)
        .set({ homeBaseLocationId })
        .where(eq(resource.id, ac.id));
    });
  }
  return ac.id;
}

async function insertBookingRequest(
  orgId: string,
  overrides: Partial<{
    status: string;
    requesterName: string;
    requesterEmail: string;
    requesterPhone: string | null;
    message: string | null;
  }> = {},
): Promise<string> {
  const status = overrides.status ?? 'new';
  // booking_request_handled_shape_check: a non-'new' row must have handled_at set.
  const handled = status !== 'new';
  return withOrgContext(env.db, orgId, async (tx) => {
    const result = await (tx as PgliteTestClient).execute(sql`
      INSERT INTO booking_request (
        org_id, status, requester_name, requester_email, requester_phone,
        requested_start, message, handled_at
      ) VALUES (
        ${orgId}::uuid,
        ${status},
        ${overrides.requesterName ?? 'Pat Requester'},
        ${overrides.requesterEmail ?? 'pat@requester.example'},
        ${overrides.requesterPhone ?? null},
        ${'2027-06-01T10:00:00Z'}::timestamptz,
        ${overrides.message ?? null},
        ${handled ? sql`now()` : sql`NULL`}
      )
      RETURNING id
    `);
    const rows = result.rows as Array<{ id: string }>;
    return rows[0]!.id;
  });
}

async function fetchRequest(orgId: string, id: string): Promise<Record<string, unknown> | null> {
  return withOrgContext(env.db, orgId, async (tx) => {
    const r = await (tx as PgliteTestClient).execute(sql`
      SELECT * FROM booking_request WHERE id = ${id}::uuid
    `);
    const rows = r.rows as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  });
}

async function countReservations(orgId: string): Promise<number> {
  return withOrgContext(env.db, orgId, async (tx) => {
    const r = await (tx as PgliteTestClient).execute(sql`
      SELECT COUNT(*)::int AS cnt FROM reservation WHERE org_id = ${orgId}::uuid
    `);
    return (r.rows as Array<{ cnt: number }>)[0]?.cnt ?? 0;
  });
}

async function countConvertAudits(orgId: string, entityId: string): Promise<number> {
  return withOrgContext(env.db, orgId, async (tx) => {
    const r = await (tx as PgliteTestClient).execute(sql`
      SELECT COUNT(*)::int AS cnt FROM audit_log
      WHERE org_id = ${orgId}::uuid
        AND action = 'booking_request.converted'
        AND entity_id = ${entityId}::uuid
    `);
    return (r.rows as Array<{ cnt: number }>)[0]?.cnt ?? 0;
  });
}

async function countAppUsers(orgId: string): Promise<number> {
  return withOrgContext(env.db, orgId, async (tx) => {
    const r = await (tx as PgliteTestClient).execute(sql`
      SELECT COUNT(*)::int AS cnt FROM app_user WHERE org_id = ${orgId}::uuid
    `);
    return (r.rows as Array<{ cnt: number }>)[0]?.cnt ?? 0;
  });
}

async function setTwilightConfig(
  orgId: string,
  cfg: { enabled: boolean; mode: 'warn' | 'block' },
): Promise<void> {
  await withOrgContext(env.db, orgId, async (tx) => {
    await tx.delete(dispatchConfig);
    await tx.insert(dispatchConfig).values({
      orgId,
      twilightConstraintEnabled: cfg.enabled,
      twilightMode: cfg.mode,
    });
  });
}

async function setAvailabilityConfig(
  orgId: string,
  cfg: { enabled: boolean; mode: 'warn' | 'block' },
): Promise<void> {
  await withOrgContext(env.db, orgId, async (tx) => {
    await tx.delete(dispatchConfig);
    await tx.insert(dispatchConfig).values({
      orgId,
      availabilityConstraintEnabled: cfg.enabled,
      availabilityMode: cfg.mode,
    });
  });
}

async function clearConfig(orgId: string): Promise<void> {
  await withOrgContext(env.db, orgId, async (tx) => {
    await tx.delete(dispatchConfig);
  });
}

async function setCoords(orgId: string, locationId: string): Promise<void> {
  await withOrgContext(env.db, orgId, async (tx) => {
    await tx
      .update(location)
      .set({ latitude: String(LAT), longitude: String(LON) })
      .where(eq(location.id, locationId));
  });
}

// ── Setup ────────────────────────────────────────────────────────────────────

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
    locationAId: seed.locationAId,
    locationBId: seed.locationBId,
    userAId: seed.userAId,
    userBId: seed.userBId,
  };
}, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
// HEADLINE — routes through the FROZEN gatedCreateOccurrence (NO bespoke INSERT)
// ═════════════════════════════════════════════════════════════════════════════

describe('HEADLINE — gatedCreateOccurrence is the only write path', () => {
  it('STRUCT-1: convert-booking-request.ts contains NO bespoke reservation INSERT', () => {
    const src = readFileSync(resolve(__dirname, '../booking/convert-booking-request.ts'), 'utf-8');
    // No Drizzle reservation insert.
    expect(src).not.toMatch(/insert\(\s*reservation/);
    // No raw SQL INSERT INTO reservation / reservation_resource.
    expect(src).not.toMatch(/INSERT\s+INTO\s+reservation/i);
    // It DOES route through the gate.
    expect(src).toMatch(/gatedCreateOccurrence/);
  });

  it('ROUTE-1: success → reservation has created_by = staff + audit metadata.bookingRequestId', async () => {
    const { orgAId, userAId, locationAId } = env;
    await clearConfig(orgAId);
    await setCoords(orgAId, locationAId);
    const acId = await mkAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);
    const reqId = await insertBookingRequest(orgAId);

    const result = await convertBookingRequestWithDb(env.db, sess, {
      id: reqId,
      resourceId: acId,
      startAt: DAY_START,
      endAt: DAY_END,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rsvId = result.reservationId;

    // created_by is the staff session user (NOT a new requester user).
    expect(result.reservation.createdBy).toBe(userAId);

    // The reservation.created audit row carries the source linkage.
    const auditMeta = await withOrgContext(env.db, orgAId, async (tx) => {
      const r = await (tx as PgliteTestClient).execute(sql`
        SELECT metadata FROM audit_log
        WHERE action = 'reservation.created' AND entity_id = ${rsvId}::uuid
        LIMIT 1
      `);
      return (r.rows as Array<{ metadata: Record<string, unknown> }>)[0]?.metadata;
    });
    expect(auditMeta).toBeTruthy();
    expect(auditMeta!['bookingRequestId']).toBe(reqId);
    expect(auditMeta!['source']).toBe('booking_request');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUCCESS — atomic convert
// ═════════════════════════════════════════════════════════════════════════════

describe('SUCCESS — atomic convert', () => {
  it('OK-1: reservation created + request converted + link set both ways', async () => {
    const { orgAId, userAId } = env;
    await clearConfig(orgAId);
    const acId = await mkAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);
    const reqId = await insertBookingRequest(orgAId);

    const result = await convertBookingRequestWithDb(env.db, sess, {
      id: reqId, resourceId: acId, startAt: DAY_START, endAt: DAY_END,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await fetchRequest(orgAId, reqId);
    expect(row!['status']).toBe('converted');
    expect(row!['converted_reservation_id']).toBe(result.reservationId);
    expect(row!['handled_by']).toBe(userAId);
    expect(row!['handled_at']).not.toBeNull();

    // The reservation exists + the link points back consistently.
    const rsv = await withOrgContext(env.db, orgAId, async (tx) => {
      const r = await tx.select().from(reservation).where(eq(reservation.id, result.reservationId)).execute();
      return r[0];
    });
    expect(rsv).toBeTruthy();
    expect(result.reservation.id).toBe(rsv!.id);
  });

  it('OK-2: exactly ONE booking_request.converted audit row, ids-only metadata (NO PII)', async () => {
    const { orgAId, userAId } = env;
    await clearConfig(orgAId);
    const acId = await mkAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);
    const reqId = await insertBookingRequest(orgAId, {
      requesterName: 'Secret Name', requesterEmail: 'secret@pii.example',
    });

    expect(await countConvertAudits(orgAId, reqId)).toBe(0);
    const result = await convertBookingRequestWithDb(env.db, sess, {
      id: reqId, resourceId: acId, startAt: DAY_START, endAt: DAY_END,
    });
    expect(result.ok).toBe(true);
    expect(await countConvertAudits(orgAId, reqId)).toBe(1);

    const meta = await withOrgContext(env.db, orgAId, async (tx) => {
      const r = await (tx as PgliteTestClient).execute(sql`
        SELECT metadata FROM audit_log
        WHERE action = 'booking_request.converted' AND entity_id = ${reqId}::uuid LIMIT 1
      `);
      return (r.rows as Array<{ metadata: Record<string, unknown> }>)[0]!.metadata;
    });
    expect(meta['previousStatus']).toBe('new');
    expect(meta['reservationId']).toBeTruthy();
    expect(meta['resourceId']).toBe(acId);
    // NO requester PII in the audit metadata.
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain('Secret Name');
    expect(serialized).not.toContain('secret@pii.example');
  });

  it('OK-3: derived notes contain requester name + email; NO app_user row created', async () => {
    const { orgAId, userAId } = env;
    await clearConfig(orgAId);
    const acId = await mkAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);
    const usersBefore = await countAppUsers(orgAId);
    const reqId = await insertBookingRequest(orgAId, {
      requesterName: 'Jamie Pilot', requesterEmail: 'jamie@pilot.example', requesterPhone: '555-0100',
    });

    const result = await convertBookingRequestWithDb(env.db, sess, {
      id: reqId, resourceId: acId, startAt: DAY_START, endAt: DAY_END,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.reservation.notes).toContain('Jamie Pilot');
    expect(result.reservation.notes).toContain('jamie@pilot.example');
    expect(result.reservation.notes).toContain('555-0100');

    // No member/pilot was created — converting does NOT create an app_user.
    expect(await countAppUsers(orgAId)).toBe(usersBefore);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// REFUSAL — atomic per gate
// ═════════════════════════════════════════════════════════════════════════════

/** Assert the request is intact + no convert audit + reservation count unchanged. */
async function assertNoSideEffects(orgId: string, reqId: string, rsvBefore: number) {
  const row = await fetchRequest(orgId, reqId);
  // Still new or contacted, link NULL, handled_at unchanged (NULL — never handled).
  expect(['new', 'contacted']).toContain(row!['status']);
  expect(row!['converted_reservation_id']).toBeNull();
  expect(row!['handled_at']).toBeNull();
  expect(await countConvertAudits(orgId, reqId)).toBe(0);
  expect(await countReservations(orgId)).toBe(rsvBefore);
}

describe('REFUSAL — atomic per gate (NO write; request intact)', () => {
  it('REF-conflict: a competing booked window → reason:conflict, nothing written', async () => {
    const { orgAId, userAId } = env;
    await clearConfig(orgAId);
    const acId = await mkAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);

    // Occupy the window on this aircraft.
    const blocker = await createReservationWithDb(env.db, sess, {
      startAt: DAY_START, endAt: DAY_END, resourceIds: [acId],
    });
    expect(blocker.ok).toBe(true);

    const rsvBefore = await countReservations(orgAId);
    const reqId = await insertBookingRequest(orgAId);
    const result = await convertBookingRequestWithDb(env.db, sess, {
      id: reqId, resourceId: acId, startAt: DAY_START, endAt: DAY_END,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('conflict');
    await assertNoSideEffects(orgAId, reqId, rsvBefore);
  });

  it('REF-policy: max-duration policy block → reason:policy, nothing written', async () => {
    const { orgAId, userAId } = env;
    await clearConfig(orgAId);
    const acId = await mkAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);

    // Policy: max 30 min. Requested window is 60 min → policy block.
    await upsertBookingPolicyWithDb(env.db, sess, { resourceId: acId, maxDurationMinutes: 30 });

    const rsvBefore = await countReservations(orgAId);
    const reqId = await insertBookingRequest(orgAId);
    const result = await convertBookingRequestWithDb(env.db, sess, {
      id: reqId, resourceId: acId, startAt: DAY_START, endAt: DAY_END,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('policy');
    await assertNoSideEffects(orgAId, reqId, rsvBefore);
  });

  it('REF-twilight: block mode + night window → reason:twilight, nothing written', async () => {
    const { orgAId, userAId, locationAId } = env;
    await setCoords(orgAId, locationAId);
    await setTwilightConfig(orgAId, { enabled: true, mode: 'block' });
    const acId = await mkAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);

    const rsvBefore = await countReservations(orgAId);
    const reqId = await insertBookingRequest(orgAId);
    const result = await convertBookingRequestWithDb(env.db, sess, {
      id: reqId, resourceId: acId, startAt: NIGHT_START, endAt: NIGHT_END,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('twilight');
    await assertNoSideEffects(orgAId, reqId, rsvBefore);
    await clearConfig(orgAId);
  });

  it('REF-availability: block mode + out-of-hours window → reason:availability, nothing written', async () => {
    const { orgAId, userAId } = env;
    const acId = await mkAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);

    // Operating-hours window only covers a slice that the candidate falls OUTSIDE.
    // DAY_START/DAY_END are on a specific weekday; give the aircraft a window on a
    // DIFFERENT minute range so the candidate is fully outside operating hours.
    const dow = DAY_START.getUTCDay();
    await createAvailabilityWindowWithDb(env.db, sess, {
      resourceId: acId,
      dayOfWeek: dow,
      startMinute: 0,
      endMinute: 1, // 00:00–00:01 UTC — candidate (daytime) is fully outside.
      tz: 'UTC',
    });
    await setAvailabilityConfig(orgAId, { enabled: true, mode: 'block' });

    const rsvBefore = await countReservations(orgAId);
    const reqId = await insertBookingRequest(orgAId);
    const result = await convertBookingRequestWithDb(env.db, sess, {
      id: reqId, resourceId: acId, startAt: DAY_START, endAt: DAY_END,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('availability');
    await assertNoSideEffects(orgAId, reqId, rsvBefore);
    await clearConfig(orgAId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY / CONCURRENCY
// ═════════════════════════════════════════════════════════════════════════════

describe('IDEMPOTENCY / CONCURRENCY', () => {
  it('IDEM-1: re-convert an already-converted request → not_convertible', async () => {
    const { orgAId, userAId } = env;
    await clearConfig(orgAId);
    const acId = await mkAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);
    const reqId = await insertBookingRequest(orgAId);

    const first = await convertBookingRequestWithDb(env.db, sess, {
      id: reqId, resourceId: acId, startAt: DAY_START, endAt: DAY_END,
    });
    expect(first.ok).toBe(true);

    const acId2 = await mkAircraft(orgAId, userAId);
    const second = await convertBookingRequestWithDb(env.db, sess, {
      id: reqId, resourceId: acId2, startAt: DAY_START, endAt: DAY_END,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('not_convertible');
  });

  it('IDEM-2: convert a declined request → not_convertible', async () => {
    const { orgAId, userAId } = env;
    await clearConfig(orgAId);
    const acId = await mkAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);
    const reqId = await insertBookingRequest(orgAId, { status: 'declined' });

    const result = await convertBookingRequestWithDb(env.db, sess, {
      id: reqId, resourceId: acId, startAt: DAY_START, endAt: DAY_END,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_convertible');
  });

  it('CONC-1: two parallel converts of the same request → exactly ONE reservation, loser not_convertible', async () => {
    const { orgAId, userAId } = env;
    await clearConfig(orgAId);
    const ac1 = await mkAircraft(orgAId, userAId);
    const ac2 = await mkAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);
    const reqId = await insertBookingRequest(orgAId);

    const rsvBefore = await countReservations(orgAId);

    // Two DIFFERENT aircraft + DIFFERENT windows so the gate itself does not
    // refuse either — only the FOR UPDATE + state guard decides the winner.
    const [r1, r2] = await Promise.all([
      convertBookingRequestWithDb(env.db, sess, {
        id: reqId, resourceId: ac1, startAt: DAY_START, endAt: DAY_END,
      }),
      convertBookingRequestWithDb(env.db, sess, {
        id: reqId, resourceId: ac2,
        startAt: new Date(DAY_START.getTime() + 3 * 60 * 60_000),
        endAt: new Date(DAY_END.getTime() + 3 * 60 * 60_000),
      }),
    ]);

    const oks = [r1, r2].filter((r) => r.ok);
    const losers = [r1, r2].filter((r) => !r.ok);
    expect(oks.length).toBe(1);
    expect(losers.length).toBe(1);
    const loser = losers[0]!;
    if (loser.ok) return;
    expect(loser.reason).toBe('not_convertible');

    // Exactly ONE reservation was created for this request.
    expect(await countReservations(orgAId)).toBe(rsvBefore + 1);
    const row = await fetchRequest(orgAId, reqId);
    expect(row!['status']).toBe('converted');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T-ISO — tenant isolation
// ═════════════════════════════════════════════════════════════════════════════

describe('T-ISO — tenant isolation', () => {
  it('ISO-1: org A converts org B request id → not_found, no write', async () => {
    const { orgAId, orgBId, userAId } = env;
    await clearConfig(orgAId);
    const acA = await mkAircraft(orgAId, userAId);
    const reqB = await insertBookingRequest(orgBId);
    const rsvBeforeA = await countReservations(orgAId);

    const sessA = makeSession(orgAId, userAId);
    const result = await convertBookingRequestWithDb(env.db, sessA, {
      id: reqB, resourceId: acA, startAt: DAY_START, endAt: DAY_END,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
    expect(await countReservations(orgAId)).toBe(rsvBeforeA);
    // org B's request is untouched.
    const rowB = await fetchRequest(orgBId, reqB);
    expect(rowB!['status']).toBe('new');
  });

  it('ISO-2: org A converts using org B resourceId → ValidationError, no write', async () => {
    const { orgAId, orgBId, userAId, userBId } = env;
    await clearConfig(orgAId);
    const acB = await mkAircraft(orgBId, userBId);
    const reqA = await insertBookingRequest(orgAId);
    const rsvBeforeA = await countReservations(orgAId);

    const sessA = makeSession(orgAId, userAId);
    // org B's resource is not visible in org A's tx → gatedCreateOccurrence throws
    // ValidationError ("resource not found in this org") → no write.
    await expect(
      convertBookingRequestWithDb(env.db, sessA, {
        id: reqA, resourceId: acB, startAt: DAY_START, endAt: DAY_END,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await countReservations(orgAId)).toBe(rsvBeforeA);
    const rowA = await fetchRequest(orgAId, reqA);
    expect(rowA!['status']).toBe('new');
    expect(rowA!['converted_reservation_id']).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CAP — capability enforcement (BOTH caps, in order)
// ═════════════════════════════════════════════════════════════════════════════

describe('CAP — capability enforcement (booking:triage THEN schedule:create_reservation)', () => {
  const BOTH: MembershipRole[] = ['owner', 'manager', 'dispatcher'];

  for (const role of BOTH) {
    it(`CAP-1: ${role} (both caps) succeeds`, async () => {
      const { orgAId, userAId } = env;
      await clearConfig(orgAId);
      const acId = await mkAircraft(orgAId, userAId);
      const sess = makeSession(orgAId, userAId, role);
      const reqId = await insertBookingRequest(orgAId);
      const result = await convertBookingRequestWithDb(env.db, sess, {
        id: reqId, resourceId: acId, startAt: DAY_START, endAt: DAY_END,
      });
      expect(result.ok).toBe(true);
    });
  }

  it('CAP-2: cfi (has schedule:create_reservation, LACKS booking:triage) → Forbidden on the FIRST check', async () => {
    // NOTE: the spec narrative said "owner/manager/dispatcher/cfi succeed", but the
    // FROZEN capability table grants cfi schedule:create_reservation WITHOUT
    // booking:triage. Per the spec's own authz ORDER (triage FIRST), cfi is refused
    // on the booking:triage check. We assert the table-truthful behavior. See report.
    const { orgAId, userAId } = env;
    const acId = await mkAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId, 'cfi');
    const reqId = await insertBookingRequest(orgAId);
    await expect(
      convertBookingRequestWithDb(env.db, sess, {
        id: reqId, resourceId: acId, startAt: DAY_START, endAt: DAY_END,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // No write happened.
    const row = await fetchRequest(orgAId, reqId);
    expect(row!['status']).toBe('new');
  });

  it('CAP-3: accountant (lacks both caps) → ForbiddenError', async () => {
    const { orgAId, userAId } = env;
    const acId = await mkAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId, 'accountant');
    const reqId = await insertBookingRequest(orgAId);
    await expect(
      convertBookingRequestWithDb(env.db, sess, {
        id: reqId, resourceId: acId, startAt: DAY_START, endAt: DAY_END,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('CAP-4: null session → UnauthenticatedError', async () => {
    const { orgAId, userAId } = env;
    const acId = await mkAircraft(orgAId, userAId);
    const reqId = await insertBookingRequest(orgAId);
    await expect(
      convertBookingRequestWithDb(env.db, null, {
        id: reqId, resourceId: acId, startAt: DAY_START, endAt: DAY_END,
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

describe('VALIDATION', () => {
  it('VAL-1: bad uuid → ValidationError', async () => {
    const { orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId);
    await expect(
      convertBookingRequestWithDb(env.db, sess, {
        id: 'not-a-uuid', resourceId: 'also-bad', startAt: DAY_START, endAt: DAY_END,
      } as never),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('VAL-2: endAt <= startAt → ValidationError', async () => {
    const { orgAId, userAId } = env;
    const acId = await mkAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);
    const reqId = await insertBookingRequest(orgAId);
    await expect(
      convertBookingRequestWithDb(env.db, sess, {
        id: reqId, resourceId: acId, startAt: DAY_END, endAt: DAY_START,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// WARN — warn-mode passthrough
// ═════════════════════════════════════════════════════════════════════════════

describe('WARN — warn-mode passthrough', () => {
  it('WARN-1: twilight warn-mode night window → ok:true + twilightWarnings, still converted', async () => {
    const { orgAId, userAId, locationAId } = env;
    await setCoords(orgAId, locationAId);
    await setTwilightConfig(orgAId, { enabled: true, mode: 'warn' });
    const acId = await mkAircraft(orgAId, userAId, locationAId);
    const sess = makeSession(orgAId, userAId);
    const reqId = await insertBookingRequest(orgAId);

    const result = await convertBookingRequestWithDb(env.db, sess, {
      id: reqId, resourceId: acId, startAt: NIGHT_START, endAt: NIGHT_END,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.twilightWarnings).toBeDefined();
    expect(result.twilightWarnings!.length).toBeGreaterThan(0);

    const row = await fetchRequest(orgAId, reqId);
    expect(row!['status']).toBe('converted');
    await clearConfig(orgAId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LIST — convertedReservationId projection (read-only additive)
// ═════════════════════════════════════════════════════════════════════════════

describe('LIST — convertedReservationId projection', () => {
  it('PROJ-1: converted rows expose convertedReservationId; new rows expose null', async () => {
    const { orgAId, userAId } = env;
    await clearConfig(orgAId);
    const acId = await mkAircraft(orgAId, userAId);
    const sess = makeSession(orgAId, userAId);

    const reqNew = await insertBookingRequest(orgAId);
    const reqConv = await insertBookingRequest(orgAId);
    const conv = await convertBookingRequestWithDb(env.db, sess, {
      id: reqConv, resourceId: acId, startAt: DAY_START, endAt: DAY_END,
    });
    expect(conv.ok).toBe(true);
    if (!conv.ok) return;

    const newList = await listBookingRequestsWithDb(env.db, sess, { status: 'new' });
    const newRow = newList.rows.find((r) => r.id === reqNew);
    expect(newRow).toBeTruthy();
    expect(newRow!.convertedReservationId).toBeNull();

    const convList = await listBookingRequestsWithDb(env.db, sess, { status: 'converted' });
    const convRow = convList.rows.find((r) => r.id === reqConv);
    expect(convRow).toBeTruthy();
    expect(convRow!.convertedReservationId).toBe(conv.reservationId);
  });
});
