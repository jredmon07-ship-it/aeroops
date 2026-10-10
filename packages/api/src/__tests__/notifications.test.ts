/**
 * notifications.test.ts — Integration + unit tests for Slice P1.3: Email
 * notifications.
 *
 * Applies migrations 0000–0026. Every DB-touching test injects a FAKE
 * EmailProvider — NEVER a real HTTP call.
 *
 * COVERAGE:
 *   1. Template rendering — one test per event type (pure, no I/O).
 *   2. sendNotification writes the correct notification_log row on a
 *      successful send.
 *   3. Opted-out (notification_pref.email_enabled=false) → 'skipped' log
 *      row, provider never called.
 *   4. Provider error → 'failed' log row with error_detail; sendNotification
 *      returns a typed result and does NOT throw.
 *   5. Unconfigured stub path — StubEmailProvider never throws + logs a
 *      synthetic id; getEmailProvider() resolves to it when env is unset.
 *   6. Tenant isolation (T-ISO) on notification_log + notification_pref.
 *   7. A hook failure (provider always throws) does NOT break the core
 *      action it rides on (reportSquawk still succeeds/persists regardless
 *      of the notification outcome).
 *   8. getMyNotificationPrefs / setMyNotificationPref: self-scoped, default
 *      opt-in, upsert idempotency, app:access-only gate (every role passes).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  appUser,
  membership,
  resource,
  squawk,
  notificationLog,
  notificationPref,
  loadMigrationSql,
} from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';
import type { PGlite } from '@electric-sql/pglite';

import { sendNotificationWithDb } from '../notifications/send-notification.js';
import type { SendNotificationInput } from '../notifications/send-notification.js';
import { renderNotificationTemplate } from '../notifications/templates.js';
import { StubEmailProvider, EmailProviderError, getEmailProvider, __resetEmailProviderForTests } from '../notifications/email-provider.js';
import type { EmailProvider, SendEmailInput, SendEmailResult } from '../notifications/email-provider.js';
import { getMyNotificationPrefsWithDb, setMyNotificationPrefWithDb } from '../notifications/prefs.js';
import { reportSquawkWithDb } from '../maintenance/report-squawk.js';

import { UnauthenticatedError } from '../auth/session.js';
import type { AppSession } from '../auth/types.js';

// All up migrations through 0038 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0038');

// ── Fake EmailProvider — NO real HTTP call, ever ───────────────────────────────

class FakeEmailProvider implements EmailProvider {
  sends: SendEmailInput[] = [];
  private counter = 0;
  /** When set, every send() throws this instead of recording. */
  throwOnSend: Error | null = null;

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (this.throwOnSend) {
      throw this.throwOnSend;
    }
    this.counter += 1;
    this.sends.push(input);
    return { id: `fake_${this.counter}` };
  }
}

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
let tailSuffix = 0;
function nextTail(prefix: string): string {
  tailSuffix += 1;
  return `${prefix}${tailSuffix}`;
}

async function seedMember(db: PgliteTestClient, orgId: string, tag: string): Promise<{ id: string; email: string }> {
  const tail = nextTail(tag);
  const email = `${tail.toLowerCase()}@example.test`;
  const rows = await withOrgContext(db, orgId, (tx) =>
    tx.insert(appUser).values({ orgId, email, fullName: `Member ${tail}` }).returning({ id: appUser.id }),
  );
  const row = rows[0];
  if (!row) throw new Error('seedMember: INSERT returned no row');
  await withOrgContext(db, orgId, (tx) => tx.insert(membership).values({ orgId, userId: row.id, role: 'renter' }));
  return { id: row.id, email };
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
    userAId: seed.userAId,
    userBId: seed.userBId,
  };
}, 120_000);

// ════════════════════════════════════════════════════════════════════════════════
// 1. Template rendering — pure, per event type
// ════════════════════════════════════════════════════════════════════════════════

describe('renderNotificationTemplate — pure per-event templates', () => {
  it('reservation.created', () => {
    const r = renderNotificationTemplate('reservation.created', {
      startAt: new Date('2026-08-01T14:00:00Z'),
      endAt: new Date('2026-08-01T16:00:00Z'),
      resourceIds: ['N152AB'],
    });
    expect(r.subject).toMatch(/reservation/i);
    expect(r.text).toContain('N152AB');
    expect(r.html).toContain('N152AB');
    // Compliance posture: plain operator-operational copy, no FAA language.
    expect(r.text.toLowerCase()).not.toContain('faa');
  });

  it('squawk.reported', () => {
    const r = renderNotificationTemplate('squawk.reported', {
      resourceId: 'res-1',
      title: 'Rough idle',
      severity: 'medium',
    });
    expect(r.subject).toMatch(/squawk/i);
    expect(r.text).toContain('Rough idle');
    expect(r.text).toContain('medium');
  });

  it('aircraft.grounded', () => {
    const r = renderNotificationTemplate('aircraft.grounded', {
      resourceId: 'res-1',
      reason: 'Engine inspection',
    });
    expect(r.subject).toMatch(/grounded/i);
    expect(r.text).toContain('Engine inspection');
    expect(r.text.toLowerCase()).not.toContain('part 91');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2/3/4. sendNotification — log rows, opt-out, provider error
// ════════════════════════════════════════════════════════════════════════════════

describe('sendNotification — logging + opt-out + provider-error behaviour', () => {
  it('successful send writes ONE notification_log row with status=sent, recipient email + subject only', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMember(env.db, env.orgAId, 'SendOk');
    const provider = new FakeEmailProvider();

    const result = await sendNotificationWithDb(
      env.db,
      sess,
      {
        toUserId: member.id,
        eventType: 'reservation.created',
        templateData: { startAt: new Date(), endAt: new Date(), resourceIds: ['N1A'] },
      },
      provider,
    );

    expect(result).toEqual({ sent: true });
    expect(provider.sends).toHaveLength(1);
    expect(provider.sends[0]!.to).toBe(member.email);

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(notificationLog).where(eq(notificationLog.userId, member.id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('sent');
    expect(rows[0]!.toEmail).toBe(member.email);
    expect(rows[0]!.channel).toBe('email');
    expect(rows[0]!.eventType).toBe('reservation.created');
    expect(rows[0]!.errorDetail).toBeNull();
  });

  it('opted-out (email_enabled=false) → status=skipped, provider NEVER called', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMember(env.db, env.orgAId, 'OptOut');
    const provider = new FakeEmailProvider();

    // Opt out of squawk.reported for this member.
    await setMyNotificationPrefWithDb(env.db, makeSession(env.orgAId, member.id, 'renter'), {
      eventType: 'squawk.reported',
      emailEnabled: false,
    });

    const result = await sendNotificationWithDb(
      env.db,
      sess,
      { toUserId: member.id, eventType: 'squawk.reported', templateData: { resourceId: 'r1', title: 't', severity: 'low' } },
      provider,
    );

    expect(result).toEqual({ sent: false, reason: 'opted_out' });
    expect(provider.sends).toHaveLength(0);

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(notificationLog)
        .where(and(eq(notificationLog.userId, member.id), eq(notificationLog.eventType, 'squawk.reported'))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('skipped');
  });

  it('provider throws → status=failed log row with error_detail; sendNotification returns a typed result, never throws', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMember(env.db, env.orgAId, 'ProvFail');
    const provider = new FakeEmailProvider();
    provider.throwOnSend = new EmailProviderError('Resend send failed (HTTP 500)', 500);

    let thrown = false;
    let result: Awaited<ReturnType<typeof sendNotificationWithDb>> | undefined;
    try {
      result = await sendNotificationWithDb(
        env.db,
        sess,
        { toUserId: member.id, eventType: 'aircraft.grounded', templateData: { resourceId: 'res-x', reason: 'Test grounding' } },
        provider,
      );
    } catch {
      thrown = true;
    }

    expect(thrown).toBe(false);
    expect(result).toEqual({ sent: false, reason: 'provider_error' });

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(notificationLog)
        .where(and(eq(notificationLog.userId, member.id), eq(notificationLog.eventType, 'aircraft.grounded'))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.errorDetail).toContain('Resend send failed');
  });

  it('recipient not found in this org → sent:false, no log row (nothing org-scoped to attach it to)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const provider = new FakeEmailProvider();
    const result = await sendNotificationWithDb(
      env.db,
      sess,
      {
        toUserId: '00000000-0000-0000-0000-000000000000',
        eventType: 'aircraft.grounded',
        templateData: { resourceId: 'res-x', reason: 'Test grounding' },
      },
      provider,
    );
    expect(result).toEqual({ sent: false, reason: 'recipient_not_found' });
    expect(provider.sends).toHaveLength(0);
  });

  it('null session → sent:false internal_error (UnauthenticatedError swallowed, never thrown to caller)', async () => {
    const provider = new FakeEmailProvider();
    const input: SendNotificationInput = {
      toUserId: env.userAId,
      eventType: 'aircraft.grounded',
      templateData: { resourceId: 'res-x', reason: 'Test grounding' },
    };
    const result = await sendNotificationWithDb(env.db, null, input, provider);
    expect(result.sent).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5. Unconfigured stub path
// ════════════════════════════════════════════════════════════════════════════════

describe('email-provider seam — unconfigured stub path', () => {
  it('StubEmailProvider.send NEVER throws and returns a synthetic id', async () => {
    const stub = new StubEmailProvider();
    const result = await stub.send({ to: 'a@example.test', subject: 'hi', html: '<p>hi</p>', text: 'hi' });
    expect(result.id).toMatch(/^stub_/);
  });

  it('getEmailProvider() resolves to StubEmailProvider when EMAIL_API_KEY/EMAIL_FROM are unset', () => {
    const prevKey = process.env['EMAIL_API_KEY'];
    const prevFrom = process.env['EMAIL_FROM'];
    delete process.env['EMAIL_API_KEY'];
    delete process.env['EMAIL_FROM'];
    __resetEmailProviderForTests();
    try {
      const provider = getEmailProvider();
      expect(provider).toBeInstanceOf(StubEmailProvider);
    } finally {
      if (prevKey !== undefined) process.env['EMAIL_API_KEY'] = prevKey;
      if (prevFrom !== undefined) process.env['EMAIL_FROM'] = prevFrom;
      __resetEmailProviderForTests();
    }
  });

  it('sendNotification with the real (unconfigured-default) provider selector still writes a sent log row (byte-identical caller experience)', async () => {
    const prevKey = process.env['EMAIL_API_KEY'];
    const prevFrom = process.env['EMAIL_FROM'];
    delete process.env['EMAIL_API_KEY'];
    delete process.env['EMAIL_FROM'];
    __resetEmailProviderForTests();
    try {
      const sess = makeSession(env.orgAId, env.userAId, 'owner');
      const member = await seedMember(env.db, env.orgAId, 'StubPath');
      const result = await sendNotificationWithDb(env.db, sess, {
        toUserId: member.id,
        eventType: 'aircraft.grounded',
        templateData: { resourceId: 'res-x', reason: 'Test grounding' },
      });
      expect(result).toEqual({ sent: true });
    } finally {
      if (prevKey !== undefined) process.env['EMAIL_API_KEY'] = prevKey;
      if (prevFrom !== undefined) process.env['EMAIL_FROM'] = prevFrom;
      __resetEmailProviderForTests();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 6. Tenant isolation (T-ISO)
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO — tenant isolation on notification_log + notification_pref', () => {
  it('org A cannot see org B notification_log rows', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const memberA = await seedMember(env.db, env.orgAId, 'IsoLogA');
    const memberB = await seedMember(env.db, env.orgBId, 'IsoLogB');
    const provider = new FakeEmailProvider();

    await sendNotificationWithDb(
      env.db,
      sessA,
      { toUserId: memberA.id, eventType: 'aircraft.grounded', templateData: { resourceId: 'res-x', reason: 'Test grounding' } },
      provider,
    );
    await sendNotificationWithDb(
      env.db,
      sessB,
      { toUserId: memberB.id, eventType: 'aircraft.grounded', templateData: { resourceId: 'res-x', reason: 'Test grounding' } },
      provider,
    );

    const rowsAsA = await withOrgContext(env.db, env.orgAId, (tx) => tx.select().from(notificationLog));
    const rowsAsB = await withOrgContext(env.db, env.orgBId, (tx) => tx.select().from(notificationLog));

    expect(rowsAsA.some((r) => r.userId === memberB.id)).toBe(false);
    expect(rowsAsB.some((r) => r.userId === memberA.id)).toBe(false);
  });

  it('org A cannot see or overwrite org B notification_pref rows (self-scope + RLS both hold)', async () => {
    const memberA = await seedMember(env.db, env.orgAId, 'IsoPrefA');
    const memberB = await seedMember(env.db, env.orgBId, 'IsoPrefB');

    await setMyNotificationPrefWithDb(env.db, makeSession(env.orgAId, memberA.id, 'renter'), {
      eventType: 'aircraft.grounded',
      emailEnabled: false,
    });
    await setMyNotificationPrefWithDb(env.db, makeSession(env.orgBId, memberB.id, 'renter'), {
      eventType: 'aircraft.grounded',
      emailEnabled: true,
    });

    const prefsA = await getMyNotificationPrefsWithDb(env.db, makeSession(env.orgAId, memberA.id, 'renter'));
    const prefsB = await getMyNotificationPrefsWithDb(env.db, makeSession(env.orgBId, memberB.id, 'renter'));

    expect(prefsA.find((p) => p.eventType === 'aircraft.grounded')?.emailEnabled).toBe(false);
    expect(prefsB.find((p) => p.eventType === 'aircraft.grounded')?.emailEnabled).toBe(true);

    const rowsAsA = await withOrgContext(env.db, env.orgAId, (tx) => tx.select().from(notificationPref));
    expect(rowsAsA.some((r) => r.userId === memberB.id)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 7. A hook failure does NOT break its core action
// ════════════════════════════════════════════════════════════════════════════════

describe('hook resilience — a notification failure never breaks the core action', () => {
  it('reportSquawk succeeds and its row persists even when the notification provider always throws', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');

    // A visible, active aircraft resource is required by reportSquawk.
    const resourceRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .insert(resource)
        .values({ orgId: env.orgAId, kind: 'aircraft', displayName: 'Hook Test Aircraft', tailNumber: 'N999HT', active: true })
        .returning({ id: resource.id }),
    );
    const resourceId = resourceRows[0]!.id;

    // The core command — unaffected by anything notification-related, since
    // it has no awareness of sendNotification at all (mirrors the real web
    // action layer: the core command already returned/committed BEFORE the
    // best-effort notification hook runs).
    const squawkResult = await reportSquawkWithDb(env.db, sess, {
      resourceId,
      title: 'Hook resilience probe',
      severity: 'low',
    });
    expect(squawkResult.ok).toBe(true);

    // Now simulate the hook: a provider that always throws must not prevent
    // the caller from proceeding, and must not throw itself.
    const angryProvider = new FakeEmailProvider();
    angryProvider.throwOnSend = new Error('simulated provider outage');

    let hookThrew = false;
    try {
      const notifyResult = await sendNotificationWithDb(
        env.db,
        sess,
        {
          toUserId: sess.userId,
          eventType: 'squawk.reported',
          templateData: { resourceId, title: 'Hook resilience probe', severity: 'low' },
        },
        angryProvider,
      );
      expect(notifyResult.sent).toBe(false);
    } catch {
      hookThrew = true;
    }
    expect(hookThrew).toBe(false);

    // The squawk row is still intact regardless of the notification outcome.
    if (!squawkResult.ok) throw new Error('unreachable');
    const stillThere = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select({ id: squawk.id }).from(squawk).where(eq(squawk.id, squawkResult.squawk.id)),
    );
    expect(stillThere).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 8. Prefs — self-scope, default opt-in, upsert idempotency, caps
// ════════════════════════════════════════════════════════════════════════════════

describe('getMyNotificationPrefs / setMyNotificationPref', () => {
  it('default (no rows) → every event type resolves emailEnabled:true', async () => {
    const member = await seedMember(env.db, env.orgAId, 'DefaultOptIn');
    const prefs = await getMyNotificationPrefsWithDb(env.db, makeSession(env.orgAId, member.id, 'student'));
    expect(prefs.length).toBeGreaterThan(0);
    expect(prefs.every((p) => p.emailEnabled === true)).toBe(true);
  });

  it('setMyNotificationPref upserts idempotently (second call updates, does not duplicate)', async () => {
    const member = await seedMember(env.db, env.orgAId, 'UpsertIdem');
    const sess = makeSession(env.orgAId, member.id, 'student');

    await setMyNotificationPrefWithDb(env.db, sess, { eventType: 'maintenance.due', emailEnabled: false });
    await setMyNotificationPrefWithDb(env.db, sess, { eventType: 'maintenance.due', emailEnabled: true });

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(notificationPref)
        .where(and(eq(notificationPref.userId, member.id), eq(notificationPref.eventType, 'maintenance.due'))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.emailEnabled).toBe(true);
  });

  it('every role can manage its own prefs (app:access is universal)', async () => {
    for (const role of ['owner', 'manager', 'dispatcher', 'cfi', 'mechanic', 'renter', 'student', 'accountant'] as const) {
      const member = await seedMember(env.db, env.orgAId, `Role${role}`);
      const sess = makeSession(env.orgAId, member.id, role);
      await expect(
        setMyNotificationPrefWithDb(env.db, sess, { eventType: 'reservation.created', emailEnabled: false }),
      ).resolves.toEqual({ ok: true, pref: { eventType: 'reservation.created', emailEnabled: false } });
    }
  });

  it('null session ⇒ Unauthenticated', async () => {
    await expect(getMyNotificationPrefsWithDb(env.db, null)).rejects.toThrow(UnauthenticatedError);
  });

  it('invalid eventType ⇒ ValidationError (thrown, not returned)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      setMyNotificationPrefWithDb(env.db, sess, { eventType: 'not.a.real.event', emailEnabled: true }),
    ).rejects.toThrow();
  });
});
