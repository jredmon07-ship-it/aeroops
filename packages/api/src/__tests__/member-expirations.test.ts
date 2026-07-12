/**
 * member-expirations.test.ts — Integration tests for the FC-P2 member
 * expiration reminder commands + reads (addMemberExpiration /
 * deactivateMemberExpiration / listMemberExpirations / listExpiringSoonForOrg).
 *
 * Applies migrations 0000–0039 (0039 creates member_expiration).
 *
 * COMPLIANCE [VERIFY-FC-P2-A]: rows under test are OPERATOR-ENTERED reminder
 * dates only — 'expired'/'due_soon'/'ok' is pure date arithmetic, not a
 * medical/currency/legal determination. Warn-only; never blocks dispatch.
 *
 * COVERAGE:
 *   CAPS: people:manage required for add/deactivate (cfi/dispatcher = access
 *     only ⇒ Forbidden; renter ⇒ Forbidden); people:access required for both
 *     reads (renter ⇒ Forbidden); null session ⇒ Unauthenticated everywhere.
 *   ADD / LIST / DEACTIVATE: add → list shows it (soonest first); note
 *     optional; deactivated rows leave the default list (includeInactive
 *     shows them); deactivate is idempotent (alreadyInactive:true, ONE audit
 *     row total).
 *   DATE-ONLY (no tz drift): 'YYYY-MM-DD' in === 'YYYY-MM-DD' out, byte-equal
 *     (incl. a DST-transition date); status boundaries exact — expired iff
 *     expiresOn < today, due_soon iff today <= expiresOn <= today+30.
 *   listExpiringSoonForOrg WINDOWING: expired vs expiring split; horizon
 *     inclusive at today+daysAhead, exclusive after; daysAhead validation.
 *   T-ISO both directions: org B cannot add against / list an org A member;
 *     org A cannot deactivate an org B expiration; org-wide read never leaks
 *     the other org's rows.
 *   AUDIT: ONE 'people.expiration_added' + ONE 'people.expiration_deactivated'
 *     row with member/label/expiresOn metadata.
 *   VALIDATION: bad UUID, empty label, over-long label, malformed/impossible
 *     dates, over-long note ⇒ ValidationError (thrown).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq, and } from 'drizzle-orm';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  appUser,
  membership,
  auditLog,
  loadMigrationSql,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import {
  addMemberExpirationWithDb,
  deactivateMemberExpirationWithDb,
  listMemberExpirationsWithDb,
  listExpiringSoonForOrgWithDb,
  classifyExpiration,
  addDaysDateOnly,
} from '../people/member-expirations.js';

import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// All up migrations through 0039 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0039');

// ── Shared test environment ───────────────────────────────────────────────────

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
}

function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'] = 'owner',
): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

let env: TestEnv;
let memberSuffix = 0;

/** Insert a fresh app_user + membership in the given org. Returns userId. */
async function seedMember(db: PgliteTestClient, orgId: string, tag: string): Promise<string> {
  memberSuffix += 1;
  const label = `${tag}${memberSuffix}`;
  const rows = await withOrgContext(db, orgId, (tx) =>
    tx
      .insert(appUser)
      .values({ orgId, email: `${label.toLowerCase()}@example.test`, fullName: `Member ${label}` })
      .returning({ id: appUser.id }),
  );
  const row = rows[0];
  if (!row) throw new Error('seedMember: INSERT returned no row');
  await withOrgContext(db, orgId, (tx) =>
    tx.insert(membership).values({ orgId, userId: row.id, role: 'renter' }),
  );
  return row.id;
}

/** Add an expiration as org A owner; returns the created view. */
async function addExp(
  memberUserId: string,
  label: string,
  expiresOn: string,
  note?: string,
) {
  const sess = makeSession(env.orgAId, env.userAId, 'owner');
  const r = await addMemberExpirationWithDb(env.db, sess, {
    memberUserId,
    label,
    expiresOn,
    ...(note !== undefined ? { note } : {}),
  });
  if (!r.ok) throw new Error(`addExp: ${r.reason}`);
  return r.expiration;
}

// A fixed reference date for deterministic boundary tests ('today' seam).
const TODAY = '2026-07-15';

// ── Setup ───────────────────────────────────────────────────────────────────

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
}, 120_000);

// ════════════════════════════════════════════════════════════════════════════════
// CAPS
// ════════════════════════════════════════════════════════════════════════════════

describe('caps', () => {
  it('addMemberExpiration: null session ⇒ Unauthenticated', async () => {
    await expect(
      addMemberExpirationWithDb(env.db, null, {
        memberUserId: env.userAId,
        label: 'Medical',
        expiresOn: '2027-01-01',
      }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('addMemberExpiration: cfi (people:access, no manage) ⇒ Forbidden', async () => {
    const member = await seedMember(env.db, env.orgAId, 'CapAddCfi');
    const sess = makeSession(env.orgAId, env.userAId, 'cfi');
    await expect(
      addMemberExpirationWithDb(env.db, sess, {
        memberUserId: member,
        label: 'Medical',
        expiresOn: '2027-01-01',
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('deactivateMemberExpiration: dispatcher (people:access only) ⇒ Forbidden', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(
      deactivateMemberExpirationWithDb(env.db, sess, {
        expirationId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('deactivateMemberExpiration: null session ⇒ Unauthenticated', async () => {
    await expect(
      deactivateMemberExpirationWithDb(env.db, null, {
        expirationId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('listMemberExpirations: renter (no people cap) ⇒ Forbidden; null ⇒ Unauthenticated', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'renter');
    await expect(
      listMemberExpirationsWithDb(env.db, sess, { memberUserId: env.userAId }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      listMemberExpirationsWithDb(env.db, null, { memberUserId: env.userAId }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('listExpiringSoonForOrg: renter ⇒ Forbidden; dispatcher (people:access) OK', async () => {
    await expect(
      listExpiringSoonForOrgWithDb(env.db, makeSession(env.orgAId, env.userAId, 'renter'), {}),
    ).rejects.toThrow(ForbiddenError);

    const r = await listExpiringSoonForOrgWithDb(
      env.db,
      makeSession(env.orgAId, env.userAId, 'dispatcher'),
      {},
    );
    expect(r.ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════════════════════════════════════════

describe('validation', () => {
  it('rejects malformed input (bad UUID / empty label / long label / bad dates / long note)', async () => {
    const member = await seedMember(env.db, env.orgAId, 'Val');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');

    const bad: unknown[] = [
      { memberUserId: 'not-a-uuid', label: 'Medical', expiresOn: '2027-01-01' },
      { memberUserId: member, label: '   ', expiresOn: '2027-01-01' },
      { memberUserId: member, label: 'x'.repeat(101), expiresOn: '2027-01-01' },
      { memberUserId: member, label: 'Medical', expiresOn: '01/01/2027' },
      { memberUserId: member, label: 'Medical', expiresOn: '2027-13-01' },
      { memberUserId: member, label: 'Medical', expiresOn: '2027-02-30' },
      { memberUserId: member, label: 'Medical', expiresOn: '2027-01-01T00:00:00Z' },
      { memberUserId: member, label: 'Medical', expiresOn: '2027-01-01', note: 'n'.repeat(1001) },
    ];
    for (const input of bad) {
      await expect(addMemberExpirationWithDb(env.db, sess, input)).rejects.toThrow();
    }

    // Nothing was persisted by the failed attempts.
    const list = await listMemberExpirationsWithDb(env.db, sess, { memberUserId: member });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.expirations).toHaveLength(0);
  });

  it('listExpiringSoonForOrg rejects daysAhead out of range / non-integer', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    for (const daysAhead of [0, -5, 366, 2.5]) {
      await expect(
        listExpiringSoonForOrgWithDb(env.db, sess, { daysAhead }),
      ).rejects.toThrow();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// ADD / LIST / DEACTIVATE
// ════════════════════════════════════════════════════════════════════════════════

describe('add / list / deactivate', () => {
  it('add → list returns it soonest-first; note optional; date byte-identical', async () => {
    const member = await seedMember(env.db, env.orgAId, 'Flow');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');

    await addExp(member, 'Rental agreement', '2027-06-01', 'renews annually');
    await addExp(member, 'Medical', '2026-09-10');

    const list = await listMemberExpirationsWithDb(env.db, sess, { memberUserId: member });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.expirations).toHaveLength(2);
    // Soonest expiry first.
    expect(list.expirations[0]!.label).toBe('Medical');
    expect(list.expirations[0]!.expiresOn).toBe('2026-09-10');
    expect(list.expirations[0]!.note).toBeNull();
    expect(list.expirations[1]!.label).toBe('Rental agreement');
    expect(list.expirations[1]!.expiresOn).toBe('2027-06-01');
    expect(list.expirations[1]!.note).toBe('renews annually');
    expect(list.expirations.every((e) => e.active)).toBe(true);
  });

  it('DST-transition date round-trips byte-identical (no tz drift)', async () => {
    const member = await seedMember(env.db, env.orgAId, 'Dst');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');

    // US DST spring-forward date — a classic off-by-one-day trap for
    // Date-object round-trips. Must come back as the exact same string.
    const created = await addExp(member, 'Flight review', '2026-03-08');
    expect(created.expiresOn).toBe('2026-03-08');

    const list = await listMemberExpirationsWithDb(env.db, sess, { memberUserId: member });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.expirations[0]!.expiresOn).toBe('2026-03-08');
  });

  it('unknown member ⇒ member_not_found (nothing persisted)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await addMemberExpirationWithDb(env.db, sess, {
      memberUserId: '00000000-0000-0000-0000-000000000000',
      label: 'Medical',
      expiresOn: '2027-01-01',
    });
    expect(r).toEqual({ ok: false, reason: 'member_not_found' });
  });

  it('deactivate hides the row from the default list; includeInactive still shows it', async () => {
    const member = await seedMember(env.db, env.orgAId, 'Deact');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const created = await addExp(member, 'Medical', '2027-02-01');

    const r = await deactivateMemberExpirationWithDb(env.db, sess, {
      expirationId: created.id,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alreadyInactive).toBe(false);
    expect(r.expiration.active).toBe(false);

    const activeList = await listMemberExpirationsWithDb(env.db, sess, {
      memberUserId: member,
    });
    expect(activeList.ok).toBe(true);
    if (!activeList.ok) return;
    expect(activeList.expirations).toHaveLength(0);

    const fullList = await listMemberExpirationsWithDb(env.db, sess, {
      memberUserId: member,
      includeInactive: true,
    });
    expect(fullList.ok).toBe(true);
    if (!fullList.ok) return;
    expect(fullList.expirations).toHaveLength(1);
    expect(fullList.expirations[0]!.active).toBe(false);
  });

  it('deactivate is idempotent (alreadyInactive:true) and unknown id ⇒ not_found', async () => {
    const member = await seedMember(env.db, env.orgAId, 'Idem');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const created = await addExp(member, 'Medical', '2027-02-01');

    const first = await deactivateMemberExpirationWithDb(env.db, sess, {
      expirationId: created.id,
    });
    expect(first.ok && !first.alreadyInactive).toBe(true);

    const second = await deactivateMemberExpirationWithDb(env.db, sess, {
      expirationId: created.id,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.alreadyInactive).toBe(true);

    const missing = await deactivateMemberExpirationWithDb(env.db, sess, {
      expirationId: '00000000-0000-0000-0000-000000000000',
    });
    expect(missing).toEqual({ ok: false, reason: 'not_found' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// DATE-ONLY STATUS BOUNDARIES (via the deterministic `today` seam)
// ════════════════════════════════════════════════════════════════════════════════

describe('status boundaries — pure date arithmetic, no tz drift', () => {
  it('classifyExpiration: exact expired / due_soon / ok boundaries', () => {
    // expired iff expiresOn < today (yesterday expired; today itself is NOT).
    expect(classifyExpiration('2026-07-14', TODAY)).toBe('expired');
    expect(classifyExpiration('2026-07-15', TODAY)).toBe('due_soon');
    // due_soon inclusive through today+30 = 2026-08-14; +31 is ok.
    expect(addDaysDateOnly(TODAY, 30)).toBe('2026-08-14');
    expect(classifyExpiration('2026-08-14', TODAY)).toBe('due_soon');
    expect(classifyExpiration('2026-08-15', TODAY)).toBe('ok');
    // Month/year rollovers are pure UTC math.
    expect(addDaysDateOnly('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysDateOnly('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('listMemberExpirations statuses honor the reference date at the boundaries', async () => {
    const member = await seedMember(env.db, env.orgAId, 'Bound');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await addExp(member, 'Expired yesterday', '2026-07-14');
    await addExp(member, 'Expires today', '2026-07-15');
    await addExp(member, 'Edge of window', '2026-08-14');
    await addExp(member, 'Past the window', '2026-08-15');

    const list = await listMemberExpirationsWithDb(env.db, sess, {
      memberUserId: member,
      today: TODAY,
    });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const byLabel = new Map(list.expirations.map((e) => [e.label, e.status]));
    expect(byLabel.get('Expired yesterday')).toBe('expired');
    expect(byLabel.get('Expires today')).toBe('due_soon');
    expect(byLabel.get('Edge of window')).toBe('due_soon');
    expect(byLabel.get('Past the window')).toBe('ok');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// listExpiringSoonForOrg WINDOWING
// ════════════════════════════════════════════════════════════════════════════════

describe('listExpiringSoonForOrg', () => {
  it('splits expired vs expiring; horizon inclusive; deactivated rows excluded', async () => {
    // Fresh member in org B so org A's accumulated rows don't interfere.
    const member = await seedMember(env.db, env.orgBId, 'WinB');
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');

    const mk = async (label: string, expiresOn: string) => {
      const r = await addMemberExpirationWithDb(env.db, sessB, {
        memberUserId: member,
        label,
        expiresOn,
      });
      if (!r.ok) throw new Error('mk failed');
      return r.expiration;
    };

    await mk('B expired', '2026-07-01');
    await mk('B today', '2026-07-15');
    await mk('B in window', '2026-07-20');
    await mk('B at horizon', '2026-07-25'); // today + 10
    await mk('B past horizon', '2026-07-26');
    const gone = await mk('B deactivated', '2026-07-16');
    await deactivateMemberExpirationWithDb(env.db, sessB, { expirationId: gone.id });

    const r = await listExpiringSoonForOrgWithDb(env.db, sessB, {
      daysAhead: 10,
      today: TODAY,
    });
    expect(r.ok).toBe(true);

    expect(r.expired.map((e) => e.label)).toEqual(['B expired']);
    expect(r.expiring.map((e) => e.label)).toEqual(['B today', 'B in window', 'B at horizon']);
    // Joined display name comes from app_user.
    expect(r.expired[0]!.memberDisplayName).toMatch(/^Member WinB/);
    // Statuses are computed vs the same reference date.
    expect(r.expired[0]!.status).toBe('expired');
    expect(r.expiring.every((e) => e.status === 'due_soon')).toBe(true);
  });

  it('defaults daysAhead to 30', async () => {
    const member = await seedMember(env.db, env.orgBId, 'Win30');
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    await addMemberExpirationWithDb(env.db, sessB, {
      memberUserId: member,
      label: 'B30 edge',
      expiresOn: '2026-08-14', // today + 30
    });
    await addMemberExpirationWithDb(env.db, sessB, {
      memberUserId: member,
      label: 'B30 past',
      expiresOn: '2026-08-15', // today + 31
    });

    const r = await listExpiringSoonForOrgWithDb(env.db, sessB, { today: TODAY });
    expect(r.ok).toBe(true);
    const labels = r.expiring.map((e) => e.label);
    expect(labels).toContain('B30 edge');
    expect(labels).not.toContain('B30 past');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// AUDIT
// ════════════════════════════════════════════════════════════════════════════════

describe('audit', () => {
  it('add writes ONE people.expiration_added row; deactivate ONE people.expiration_deactivated (idempotent repeat writes none)', async () => {
    const member = await seedMember(env.db, env.orgAId, 'Aud');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const created = await addExp(member, 'Medical', '2027-03-01');

    const addedRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, 'people.expiration_added'), eq(auditLog.entityId, created.id)),
        ),
    );
    expect(addedRows).toHaveLength(1);
    expect(addedRows[0]!.actorUserId).toBe(env.userAId);
    expect(addedRows[0]!.entityType).toBe('member_expiration');
    expect(addedRows[0]!.metadata).toMatchObject({
      memberUserId: member,
      label: 'Medical',
      expiresOn: '2027-03-01',
    });

    await deactivateMemberExpirationWithDb(env.db, sess, { expirationId: created.id });
    // Idempotent second call — no additional audit row.
    await deactivateMemberExpirationWithDb(env.db, sess, { expirationId: created.id });

    const deactRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'people.expiration_deactivated'),
            eq(auditLog.entityId, created.id),
          ),
        ),
    );
    expect(deactRows).toHaveLength(1);
    expect(deactRows[0]!.metadata).toMatchObject({
      memberUserId: member,
      label: 'Medical',
      expiresOn: '2027-03-01',
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T-ISO — tenant isolation (both directions)
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO — tenant isolation', () => {
  it('org B cannot add an expiration against an org A member', async () => {
    const memberA = await seedMember(env.db, env.orgAId, 'IsoAddA');
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const r = await addMemberExpirationWithDb(env.db, sessB, {
      memberUserId: memberA,
      label: 'Medical',
      expiresOn: '2027-01-01',
    });
    expect(r).toEqual({ ok: false, reason: 'member_not_found' });

    // Nothing landed on the org A member.
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const list = await listMemberExpirationsWithDb(env.db, sessA, { memberUserId: memberA });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.expirations).toHaveLength(0);
  });

  it('org B cannot list an org A member; org A cannot deactivate an org B expiration', async () => {
    const memberA = await seedMember(env.db, env.orgAId, 'IsoListA');
    await addExp(memberA, 'Medical', '2027-01-01');

    // B → A list: member invisible.
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const listB = await listMemberExpirationsWithDb(env.db, sessB, { memberUserId: memberA });
    expect(listB).toEqual({ ok: false, reason: 'member_not_found' });

    // A → B deactivate: expiration invisible.
    const memberB = await seedMember(env.db, env.orgBId, 'IsoDeactB');
    const createdB = await addMemberExpirationWithDb(env.db, sessB, {
      memberUserId: memberB,
      label: 'Rental agreement',
      expiresOn: '2027-01-01',
    });
    expect(createdB.ok).toBe(true);
    if (!createdB.ok) return;

    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const r = await deactivateMemberExpirationWithDb(env.db, sessA, {
      expirationId: createdB.expiration.id,
    });
    expect(r).toEqual({ ok: false, reason: 'not_found' });

    // Still active in org B.
    const listBAgain = await listMemberExpirationsWithDb(env.db, sessB, {
      memberUserId: memberB,
    });
    expect(listBAgain.ok).toBe(true);
    if (!listBAgain.ok) return;
    expect(listBAgain.expirations).toHaveLength(1);
    expect(listBAgain.expirations[0]!.active).toBe(true);
  });

  it('listExpiringSoonForOrg never returns the other org’s rows', async () => {
    const memberA = await seedMember(env.db, env.orgAId, 'IsoOrgA');
    await addExp(memberA, 'A-only expired', '2026-01-01');

    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const rB = await listExpiringSoonForOrgWithDb(env.db, sessB, { today: TODAY });
    expect(rB.ok).toBe(true);
    const allB = [...rB.expired, ...rB.expiring];
    expect(allB.some((e) => e.label === 'A-only expired')).toBe(false);

    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const rA = await listExpiringSoonForOrgWithDb(env.db, sessA, { today: TODAY });
    expect(rA.ok).toBe(true);
    expect(rA.expired.some((e) => e.label === 'A-only expired')).toBe(true);
    // And no org-B labels bleed into A.
    const allA = [...rA.expired, ...rA.expiring];
    expect(allA.some((e) => e.label.startsWith('B '))).toBe(false);
  });
});
