/**
 * search-api.test.ts — Integration tests for the global org search (Slice S1.1).
 *
 * Uses pglite + migrations 0000–0013. Seeds two completely isolated orgs (A and B)
 * with identically-named entities of every type.
 *
 * IMPORTANT: ALL seeding happens in the root beforeAll, BEFORE setTestAppRole.
 * setTestAppRole switches pglite to the aeroops_app role (restricted), at which
 * point FORCE RLS is active. searchOrgWithDb uses withSessionOrgContextWithDb
 * which sets the GUC inside the callback so SELECT queries work fine.
 *
 * COVERAGE per spec §5 "Edge cases / tests":
 *
 * CAP — per-capability scoping:
 *   C1  owner (all 6 caps) → results in all 6 groups.
 *   C2  student/renter (app:access only) → { groups: [] }.
 *   C3  accountant (app:access + reporting:access) → { groups: [] }.
 *   C4  mechanic → ONLY aircraft + work_order + squawk (no member/course/reservation).
 *   C5  cfi → all 6 groups (has maintenance:access).
 *   C6  skipped-type: a matching row exists but role lacks cap → group absent.
 *
 * T-ISO — tenant isolation for EVERY type (I1–I6b).
 * LIKE-escaping: L1 (%), L2 (_).
 * SQL injection: J1.
 * Misc: M1 (case), M2–M5 (short/empty/whitespace/>200), M6 (null session),
 *       M7 (no-name → email fallback), M8 (cancelled resv not returned).
 * Counts: N1 (≤5/type), N2 (≤30 total).
 * Fixed order: O1, O2 (empty omitted).
 * Ranking: R1 (prefix before non-prefix).
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
  resource,
  appUser,
  membership,
  squawk,
  course,
  reservation,
  workOrder,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { UnauthenticatedError } from '../auth/session.js';
import type { AppSession } from '../auth/types.js';
import { searchOrgWithDb } from '../search/search-org.js';

// ─── Path resolution ──────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

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
  readFileSync(resolve(__dirname, '../../../db/migrations/0014_availability.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0015_booking_request.sql'),  'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0016_booking_request_convert.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0017_booking_retention.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0018_dispatch_ticket_correction.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0019_billing_records.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0020_demo_reset_state.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0021_qbo_integration.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0022_billing_ledger.sql'), 'utf-8'),
  // 0037 required: resource now includes category/aircraft_class (Slice P2-LOG2).
  // Drizzle ORM INSERT on resource emits all columns, so the columns must exist.
  readFileSync(resolve(__dirname, '../../../db/migrations/0037_logbook_annotation.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0038_stage_check_enforcement.sql'), 'utf-8'),
];

// ─── Session factory ──────────────────────────────────────────────────────────

function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'],
): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

// ─── Tokens — unique per test group ──────────────────────────────────────────

const CAP_TOK    = 'CapScopeZZ7';   // per-cap + order + empty-group tests
const ISO_TOK    = 'TIsoXkQR8';     // T-ISO tests
const CASE_TOK   = 'CaseTst8Qy';    // case-insensitivity tests
const EMAIL_TOK  = 'emailfb9k';     // no-name member fallback test
const CANCEL_TOK = 'CnclResvZ8';    // cancelled reservation test
const LIM_TOK    = 'LimTest9Zp';    // LIMIT 5 test
const PCT_TOK    = 'PctPlnZQ5';     // % LIKE escaping test
const UND_TOK    = 'UndPlnZQ5';     // _ LIKE escaping test
const PFX_TOK    = 'PfxRnkW7k';     // ranking (prefix) test

// ─── Shared test state (set by root beforeAll) ───────────────────────────────

let db: PgliteTestClient;
let orgAId  = '';
let orgBId  = '';
let userAId = '';
let userBId = '';

// IDs for T-ISO assertions.
let isoAircraftA = ''; let isoAircraftB = '';
let isoMemberA   = ''; let isoMemberB   = '';
let isoWoA       = ''; let isoWoB       = '';
let isoSquawkA   = ''; let isoSquawkB   = '';
let isoCourseA   = ''; let isoCourseB   = '';
let isoResvA     = ''; let isoResvB     = '';

// IDs for other assertions.
let capAircraftId  = '';
let noNameMemberId = '';

// ─── Root beforeAll (ALL seeding before setTestAppRole) ───────────────────────

beforeAll(async () => {
  const { db: drizzleDb, pglite } = await createTestClient();
  db = drizzleDb;

  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(drizzleDb);

  orgAId  = seed.orgAId;
  orgBId  = seed.orgBId;
  userAId = seed.userAId;
  userBId = seed.userBId;

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Insert an aircraft and return its id. */
  async function insAircraft(orgId: string, displayName: string, tailNumber: string): Promise<string> {
    const [row] = await withOrgContext(drizzleDb, orgId, (tx) =>
      tx.insert(resource).values({
        orgId, kind: 'aircraft', displayName, tailNumber, active: true,
      }).returning(),
    );
    return row!.id;
  }

  /** Insert an app_user + membership and return userId. */
  async function insMember(
    orgId: string,
    email: string,
    fullName: string | null,
    role: AppSession['role'] = 'renter',
  ): Promise<string> {
    return withOrgContext(drizzleDb, orgId, async (tx) => {
      const [usr] = await tx.insert(appUser).values({ orgId, email, fullName: fullName ?? undefined, status: 'active' }).returning();
      await tx.insert(membership).values({ orgId, userId: usr!.id, role });
      return usr!.id;
    });
  }

  /** Insert a work order and return its id. */
  async function insWo(orgId: string, resourceId: string, title: string, openedBy: string): Promise<string> {
    const [row] = await withOrgContext(drizzleDb, orgId, (tx) =>
      tx.insert(workOrder).values({ orgId, resourceId, title, status: 'open', openedBy }).returning(),
    );
    return row!.id;
  }

  /** Insert a squawk and return its id. */
  async function insSquawk(orgId: string, resourceId: string, title: string, reportedBy: string): Promise<string> {
    const [row] = await withOrgContext(drizzleDb, orgId, (tx) =>
      tx.insert(squawk).values({ orgId, resourceId, title, severity: 'low', status: 'open', reportedBy }).returning(),
    );
    return row!.id;
  }

  /** Insert a course and return its id. */
  async function insCourse(orgId: string, title: string, createdBy: string): Promise<string> {
    const [row] = await withOrgContext(drizzleDb, orgId, (tx) =>
      tx.insert(course).values({ orgId, title, status: 'active', createdBy }).returning(),
    );
    return row!.id;
  }

  /** Insert a reservation with notes and return its id. */
  async function insResv(
    orgId: string,
    notes: string,
    createdBy: string,
    status: 'booked' | 'cancelled' = 'booked',
    start = new Date('2027-01-10T08:00:00Z'),
    end   = new Date('2027-01-10T10:00:00Z'),
  ): Promise<string> {
    const cancelledAt: Date | undefined = status === 'cancelled' ? new Date() : undefined;
    const cancelledBy: string | undefined = status === 'cancelled' ? createdBy : undefined;
    const [row] = await withOrgContext(drizzleDb, orgId, (tx) =>
      tx.insert(reservation).values({
        orgId, startAt: start, endAt: end, status, notes, createdBy,
        cancelledAt, cancelledBy,
      }).returning(),
    );
    return row!.id;
  }

  // ── Per-cap scoping entities (CAP_TOK, org A) ────────────────────────────

  capAircraftId = await insAircraft(orgAId, `Cap Aircraft ${CAP_TOK}`, `NCAP${CAP_TOK}`);
  await insMember(orgAId, `capmem_${CAP_TOK}@ex.com`, `Cap Member ${CAP_TOK}`);
  await insWo(orgAId, capAircraftId, `Cap WO ${CAP_TOK}`, userAId);
  await insSquawk(orgAId, capAircraftId, `Cap Squawk ${CAP_TOK}`, userAId);
  await insCourse(orgAId, `Cap Course ${CAP_TOK}`, userAId);
  await insResv(orgAId, `Cap Resv notes ${CAP_TOK}`, userAId, 'booked',
    new Date('2027-09-01T08:00:00Z'), new Date('2027-09-01T10:00:00Z'));

  // ── T-ISO entities — org A ────────────────────────────────────────────────

  isoAircraftA = await insAircraft(orgAId, `ISO Aircraft ${ISO_TOK}`, `NISOA${ISO_TOK}`);
  isoMemberA   = await insMember(orgAId, `iso_a_${ISO_TOK}@ex.com`, `ISO Member ${ISO_TOK}`);
  isoWoA       = await insWo(orgAId, isoAircraftA, `ISO WO ${ISO_TOK}`, userAId);
  isoSquawkA   = await insSquawk(orgAId, isoAircraftA, `ISO Squawk ${ISO_TOK}`, userAId);
  isoCourseA   = await insCourse(orgAId, `ISO Course ${ISO_TOK}`, userAId);
  isoResvA     = await insResv(orgAId, `ISO Resv notes ${ISO_TOK}`, userAId, 'booked',
    new Date('2027-10-01T08:00:00Z'), new Date('2027-10-01T10:00:00Z'));

  // ── T-ISO entities — org B (mirror) ──────────────────────────────────────

  isoAircraftB = await insAircraft(orgBId, `ISO Aircraft ${ISO_TOK}`, `NISOB${ISO_TOK}`);
  isoMemberB   = await insMember(orgBId, `iso_b_${ISO_TOK}@ex.com`, `ISO Member ${ISO_TOK}`);
  isoWoB       = await insWo(orgBId, isoAircraftB, `ISO WO ${ISO_TOK}`, userBId);
  isoSquawkB   = await insSquawk(orgBId, isoAircraftB, `ISO Squawk ${ISO_TOK}`, userBId);
  isoCourseB   = await insCourse(orgBId, `ISO Course ${ISO_TOK}`, userBId);
  isoResvB     = await insResv(orgBId, `ISO Resv notes ${ISO_TOK}`, userBId, 'booked',
    new Date('2027-10-01T08:00:00Z'), new Date('2027-10-01T10:00:00Z'));

  // ── Case-insensitivity test ───────────────────────────────────────────────

  await insCourse(orgAId, `Private Pilot ${CASE_TOK}`, userAId);

  // ── No-name member (email fallback) ──────────────────────────────────────

  noNameMemberId = await insMember(orgAId, `${EMAIL_TOK}@ex.com`, null);

  // ── Cancelled reservation test ────────────────────────────────────────────

  await insResv(orgAId, `Booked notes ${CANCEL_TOK}`, userAId, 'booked',
    new Date('2027-11-01T09:00:00Z'), new Date('2027-11-01T11:00:00Z'));
  await insResv(orgAId, `Cancelled notes ${CANCEL_TOK}`, userAId, 'cancelled',
    new Date('2027-11-02T09:00:00Z'), new Date('2027-11-02T11:00:00Z'));

  // ── LIMIT 5 test — 7 aircraft with the same token ─────────────────────────

  for (let i = 0; i < 7; i++) {
    await insAircraft(orgAId, `Lim Aircraft ${i} ${LIM_TOK}`, `NLIM${i}${LIM_TOK}`);
  }

  // ── LIKE escaping tests ───────────────────────────────────────────────────

  await insAircraft(orgAId, `Pct%Plane ${PCT_TOK}`, `NPCT${PCT_TOK}`);
  await insAircraft(orgAId, `Und_Plane ${UND_TOK}`, `NUND${UND_TOK}`);

  // ── Ranking test — one prefix match + one mid-string match ───────────────

  await insAircraft(orgAId, `${PFX_TOK}StartMatch`, `NPFX1${PFX_TOK}`);
  await insAircraft(orgAId, `Middle${PFX_TOK}End`, `NPFX2${PFX_TOK}`);

  // ── Switch to restricted app role ─────────────────────────────────────────
  await setTestAppRole({ pglite });
}, 120_000);

// ─── Auth tests ───────────────────────────────────────────────────────────────

describe('searchOrg — authentication', () => {
  it('M6a: null session → UnauthenticatedError', async () => {
    await expect(searchOrgWithDb(db, null, { query: 'test' }))
      .rejects.toThrow(UnauthenticatedError);
  });

  it('M6b: undefined session → UnauthenticatedError', async () => {
    await expect(searchOrgWithDb(db, undefined, { query: 'test' }))
      .rejects.toThrow(UnauthenticatedError);
  });
});

// ─── Short / empty / whitespace queries ──────────────────────────────────────

describe('searchOrg — short/empty/whitespace queries', () => {
  it('M2: single char → { groups: [] }', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: 'a' });
    expect(r).toEqual({ groups: [] });
  });

  it('M3: empty string → { groups: [] }', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: '' });
    expect(r).toEqual({ groups: [] });
  });

  it('M4a: whitespace-only → { groups: [] }', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: '   ' });
    expect(r).toEqual({ groups: [] });
  });

  it('M4b: " a " trims to "a" (length 1) → { groups: [] }', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: ' a ' });
    expect(r).toEqual({ groups: [] });
  });

  it('M5: query > 200 chars → { groups: [] }', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: 'x'.repeat(201) });
    expect(r).toEqual({ groups: [] });
  });
});

// ─── SQL injection ────────────────────────────────────────────────────────────

describe('searchOrg — SQL injection safety', () => {
  it("J1: injection string doesn't error; schema intact", async () => {
    const sess = makeSession(orgAId, userAId, 'owner');
    const r = await searchOrgWithDb(db, sess, { query: "'; DROP TABLE resource;--" });
    expect(r).toHaveProperty('groups');
    expect(Array.isArray(r.groups)).toBe(true);
    // DB still alive: follow-up query works.
    const r2 = await searchOrgWithDb(db, sess, { query: ISO_TOK });
    expect(r2).toHaveProperty('groups');
  });
});

// ─── Per-capability scoping ───────────────────────────────────────────────────

describe('searchOrg — per-capability scoping', () => {
  it('C1: owner → all 6 group types present', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: CAP_TOK });
    const types = new Set(r.groups.map((g) => g.type));
    expect(types.has('aircraft')).toBe(true);
    expect(types.has('member')).toBe(true);
    expect(types.has('work_order')).toBe(true);
    expect(types.has('squawk')).toBe(true);
    expect(types.has('course')).toBe(true);
    expect(types.has('reservation')).toBe(true);
    const ag = r.groups.find((g) => g.type === 'aircraft')!;
    expect(ag.results.some((x) => x.id === capAircraftId)).toBe(true);
  });

  it('C2a: student (app:access only) → { groups: [] }', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'student'), { query: CAP_TOK });
    expect(r).toEqual({ groups: [] });
  });

  it('C2b: renter (app:access only) → { groups: [] }', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'renter'), { query: CAP_TOK });
    expect(r).toEqual({ groups: [] });
  });

  it('C3: accountant (app + reporting) → { groups: [] }', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'accountant'), { query: CAP_TOK });
    expect(r).toEqual({ groups: [] });
  });

  it('C4: mechanic → ONLY aircraft + work_order + squawk; NO member/course/reservation', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'mechanic'), { query: CAP_TOK });
    const types = new Set(r.groups.map((g) => g.type));
    expect(types.has('aircraft')).toBe(true);
    expect(types.has('work_order')).toBe(true);
    expect(types.has('squawk')).toBe(true);
    expect(types.has('member')).toBe(false);
    expect(types.has('course')).toBe(false);
    expect(types.has('reservation')).toBe(false);
  });

  it('C5: cfi → all 6 group types (maintenance:access covers WO + squawk)', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'cfi'), { query: CAP_TOK });
    const types = new Set(r.groups.map((g) => g.type));
    expect(types.has('aircraft')).toBe(true);
    expect(types.has('member')).toBe(true);
    expect(types.has('work_order')).toBe(true);
    expect(types.has('squawk')).toBe(true);
    expect(types.has('course')).toBe(true);
    expect(types.has('reservation')).toBe(true);
  });

  it('C6a: mechanic — member row exists BUT people:access absent → member group absent', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'mechanic'), { query: CAP_TOK });
    expect(r.groups.find((g) => g.type === 'member')).toBeUndefined();
  });

  it('C6b: mechanic — course row exists BUT training:access absent → course group absent', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'mechanic'), { query: CAP_TOK });
    expect(r.groups.find((g) => g.type === 'course')).toBeUndefined();
  });

  it('C6c: mechanic — reservation row exists BUT schedule:access absent → reservation group absent', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'mechanic'), { query: CAP_TOK });
    expect(r.groups.find((g) => g.type === 'reservation')).toBeUndefined();
  });
});

// ─── Tenant isolation (T-ISO) for every type ──────────────────────────────────

describe('searchOrg — tenant isolation (T-ISO)', () => {
  it('I1: aircraft — org-A session → only org-A aircraft id, NOT org-B', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: ISO_TOK });
    const g = r.groups.find((x) => x.type === 'aircraft')!;
    expect(g).toBeDefined();
    const ids = g.results.map((x) => x.id);
    expect(ids).toContain(isoAircraftA);
    expect(ids).not.toContain(isoAircraftB);
  });

  it('I2: member — org-A session → only org-A member id, NOT org-B', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: ISO_TOK });
    const g = r.groups.find((x) => x.type === 'member')!;
    expect(g).toBeDefined();
    const ids = g.results.map((x) => x.id);
    expect(ids).toContain(isoMemberA);
    expect(ids).not.toContain(isoMemberB);
  });

  it('I3: work_order — org-A session → only org-A WO id, NOT org-B', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: ISO_TOK });
    const g = r.groups.find((x) => x.type === 'work_order')!;
    expect(g).toBeDefined();
    const ids = g.results.map((x) => x.id);
    expect(ids).toContain(isoWoA);
    expect(ids).not.toContain(isoWoB);
  });

  it('I4: squawk — org-A session → only org-A squawk id, NOT org-B', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: ISO_TOK });
    const g = r.groups.find((x) => x.type === 'squawk')!;
    expect(g).toBeDefined();
    const ids = g.results.map((x) => x.id);
    expect(ids).toContain(isoSquawkA);
    expect(ids).not.toContain(isoSquawkB);
  });

  it('I5: course — org-A session → only org-A course id, NOT org-B', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: ISO_TOK });
    const g = r.groups.find((x) => x.type === 'course')!;
    expect(g).toBeDefined();
    const ids = g.results.map((x) => x.id);
    expect(ids).toContain(isoCourseA);
    expect(ids).not.toContain(isoCourseB);
  });

  it('I6: reservation — org-A session → only org-A resv id, NOT org-B', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: ISO_TOK });
    const g = r.groups.find((x) => x.type === 'reservation')!;
    expect(g).toBeDefined();
    const ids = g.results.map((x) => x.id);
    expect(ids).toContain(isoResvA);
    expect(ids).not.toContain(isoResvB);
  });

  it('I1b: org-B session → only org-B aircraft, NOT org-A', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgBId, userBId, 'owner'), { query: ISO_TOK });
    const g = r.groups.find((x) => x.type === 'aircraft')!;
    expect(g).toBeDefined();
    const ids = g.results.map((x) => x.id);
    expect(ids).toContain(isoAircraftB);
    expect(ids).not.toContain(isoAircraftA);
  });
});

// ─── LIKE escaping ────────────────────────────────────────────────────────────

describe('searchOrg — LIKE escaping', () => {
  it('L1: literal "%" in query does not act as LIKE wildcard', async () => {
    const sess = makeSession(orgAId, userAId, 'owner');
    // If '%' were unescaped, it would match everything — potentially > 30 rows.
    const r = await searchOrgWithDb(db, sess, { query: `%Plane ${PCT_TOK}` });
    const total = r.groups.reduce((n, g) => n + g.results.length, 0);
    expect(total).toBeLessThanOrEqual(30);
    // Any aircraft result must contain the literal token (not a wildcard flood).
    const ag = r.groups.find((x) => x.type === 'aircraft');
    if (ag) {
      for (const res of ag.results) {
        expect(res.primary.toLowerCase()).toContain(PCT_TOK.toLowerCase());
      }
    }
  });

  it('L2: literal "_" in query does not act as single-char wildcard', async () => {
    const sess = makeSession(orgAId, userAId, 'owner');
    const r = await searchOrgWithDb(db, sess, { query: `_Plane ${UND_TOK}` });
    const total = r.groups.reduce((n, g) => n + g.results.length, 0);
    expect(total).toBeLessThanOrEqual(30);
    const ag = r.groups.find((x) => x.type === 'aircraft');
    if (ag) {
      for (const res of ag.results) {
        expect(res.primary.toLowerCase()).toContain(UND_TOK.toLowerCase());
      }
    }
  });
});

// ─── Case-insensitivity ───────────────────────────────────────────────────────

describe('searchOrg — case-insensitivity', () => {
  it('M1a: lower-case query matches mixed-case title', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: CASE_TOK.toLowerCase() });
    const g = r.groups.find((x) => x.type === 'course');
    expect(g).toBeDefined();
    expect(g!.results.length).toBeGreaterThan(0);
  });

  it('M1b: upper-case query matches mixed-case title', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: CASE_TOK.toUpperCase() });
    const g = r.groups.find((x) => x.type === 'course');
    expect(g).toBeDefined();
    expect(g!.results.length).toBeGreaterThan(0);
  });
});

// ─── Member no-name → email fallback ──────────────────────────────────────────

describe('searchOrg — member no-name email fallback', () => {
  it('M7: member with null full_name → email as primary (never empty), secondary null', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: EMAIL_TOK });
    const g = r.groups.find((x) => x.type === 'member')!;
    expect(g).toBeDefined();
    const hit = g.results.find((x) => x.id === noNameMemberId)!;
    expect(hit).toBeDefined();
    expect(hit.primary).toBe(`${EMAIL_TOK}@ex.com`);
    expect(hit.primary.length).toBeGreaterThan(0); // never empty
    expect(hit.secondary).toBeNull();               // no full_name → secondary null
  });
});

// ─── Cancelled reservation not returned ──────────────────────────────────────

describe('searchOrg — cancelled reservation filter', () => {
  it('M8: cancelled reservations not returned; only booked', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: CANCEL_TOK });
    const g = r.groups.find((x) => x.type === 'reservation');
    if (g) {
      // Only the booked one should appear (we seeded exactly one booked + one cancelled).
      expect(g.results.length).toBe(1);
      // The cancelled row's notes should not be present.
      for (const res of g.results) {
        if (res.secondary) {
          expect(res.secondary.toLowerCase()).not.toContain('cancelled');
        }
      }
    }
  });
});

// ─── LIMIT 5 per type / ≤30 total ────────────────────────────────────────────

describe('searchOrg — LIMIT 5 per type / ≤30 total', () => {
  it('N1: ≤5 aircraft returned even when 7 rows match', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: LIM_TOK });
    const g = r.groups.find((x) => x.type === 'aircraft')!;
    expect(g).toBeDefined();
    expect(g.results.length).toBeLessThanOrEqual(5);
  });

  it('N2: total results across all groups ≤ 30', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: ISO_TOK });
    const total = r.groups.reduce((n, g) => n + g.results.length, 0);
    expect(total).toBeLessThanOrEqual(30);
  });
});

// ─── Fixed group order + empty groups omitted ─────────────────────────────────

describe('searchOrg — fixed group order and empty group omission', () => {
  it('O1: groups in fixed order (aircraft < member < work_order < squawk < course < reservation)', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: CAP_TOK });
    const FIXED = ['aircraft', 'member', 'work_order', 'squawk', 'course', 'reservation'];
    let prev = -1;
    for (const g of r.groups) {
      const idx = FIXED.indexOf(g.type);
      expect(idx).toBeGreaterThan(prev);
      prev = idx;
    }
  });

  it('O2: empty groups omitted (mechanic: no member/course/reservation groups)', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'mechanic'), { query: CAP_TOK });
    for (const g of r.groups) {
      expect(g.results.length).toBeGreaterThan(0);
    }
    expect(r.groups.find((g) => g.type === 'member')).toBeUndefined();
    expect(r.groups.find((g) => g.type === 'course')).toBeUndefined();
    expect(r.groups.find((g) => g.type === 'reservation')).toBeUndefined();
  });
});

// ─── Ranking — prefix before non-prefix ──────────────────────────────────────

describe('searchOrg — ranking (prefix before non-prefix)', () => {
  it('R1: prefix-match aircraft appears before non-prefix match', async () => {
    const r = await searchOrgWithDb(db, makeSession(orgAId, userAId, 'owner'), { query: PFX_TOK });
    const g = r.groups.find((x) => x.type === 'aircraft')!;
    expect(g).toBeDefined();
    expect(g.results.length).toBeGreaterThanOrEqual(2);
    // Verify: every prefix match comes before every non-prefix match.
    const lq = PFX_TOK.toLowerCase();
    let seenNonPrefix = false;
    for (const res of g.results) {
      const isPrefix = res.primary.toLowerCase().startsWith(lq);
      if (!isPrefix) seenNonPrefix = true;
      if (seenNonPrefix && isPrefix) {
        throw new Error(`Prefix match "${res.primary}" appeared after a non-prefix match`);
      }
    }
  });
});
