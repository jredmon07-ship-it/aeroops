/**
 * member-messaging.test.ts — API integration tests for Slice FC-P1: Member
 * messaging / announcements.
 *
 * Applies migrations 0000–0036 (0036 = member_message). Every DB-touching
 * test injects a FAKE EmailProvider via sendMemberMessageWithDb's internal
 * getEmailProvider() OR the stub path — send-member-message.ts always calls
 * getEmailProvider() itself, so these tests force the unconfigured stub
 * (EMAIL_API_KEY/EMAIL_FROM unset) — NEVER a real HTTP call.
 *
 * COVERAGE:
 *   CAPABILITIES: org:manage_settings — owner/manager OK; dispatcher/cfi/
 *     mechanic/renter/student/accountant → ForbiddenError; null →
 *     UnauthenticatedError. Same for previewMemberMessageRecipients /
 *     listMemberMessages.
 *   VALIDATION: empty subject/body, over-length subject/body, invalid
 *     audience, audience='role' missing/invalid role, audience='all_active'
 *     with a role set → ValidationError.
 *   RECIPIENT RESOLUTION: all_active excludes inactive members; role
 *     audience scopes to exactly that role; previewMemberMessageRecipients
 *     matches the count sendMemberMessage actually uses (no side effect).
 *   OPT-OUTS: a member opted out of 'org.announcement' → skipped, not sent;
 *     one failing recipient does not abort the batch.
 *   member_message ROW: recipient_count matches resolved recipients; one row
 *     per send call; APPEND-ONLY (no UPDATE/DELETE policy exists — schema-
 *     level guarantee, asserted via a direct denied-UPDATE probe).
 *   BODY: stored + sent as plain text (no HTML injection) — a body
 *     containing "<script>" round-trips as literal text in both the stored
 *     row and the rendered template's escaped html part.
 *   T-ISO: org B never receives org A's blast; listMemberMessages never
 *     returns another org's history.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  appUser,
  membership,
  auditLog,
  notificationLog,
  memberMessage,
  loadMigrationSql,
} from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import {
  sendMemberMessageWithDb,
  previewMemberMessageRecipientsWithDb,
  listMemberMessagesWithDb,
} from '../notifications/send-member-message.js';
import { setMyNotificationPrefWithDb } from '../notifications/prefs.js';
import { renderNotificationTemplate } from '../notifications/templates.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// All up migrations through 0036 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0036');

// ── Shared test env ──────────────────────────────────────────────────────────

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string; // owner, org A
  userBId: string; // owner, org B
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

async function seedMemberWithRole(
  db: PgliteTestClient,
  orgId: string,
  role: 'owner' | 'manager' | 'dispatcher' | 'cfi' | 'mechanic' | 'renter' | 'student' | 'accountant',
  tag: string,
  status: 'active' | 'inactive' = 'active',
): Promise<{ id: string; email: string }> {
  const tail = nextTail(tag);
  const email = `${tail.toLowerCase()}@example.test`;
  const rows = await withOrgContext(db, orgId, (tx) =>
    tx.insert(appUser).values({ orgId, email, fullName: `Member ${tail}`, status }).returning({ id: appUser.id }),
  );
  const row = rows[0];
  if (!row) throw new Error('seedMemberWithRole: INSERT returned no row');
  await withOrgContext(db, orgId, (tx) => tx.insert(membership).values({ orgId, userId: row.id, role }));
  return { id: row.id, email };
}

beforeAll(async () => {
  // Force the stub email provider path — never a real HTTP call.
  delete process.env['EMAIL_API_KEY'];
  delete process.env['EMAIL_FROM'];

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

// ════════════════════════════════════════════════════════════════════════════
// CAPABILITIES
// ════════════════════════════════════════════════════════════════════════════

describe('member messaging — capabilities (org:manage_settings)', () => {
  it('sendMemberMessage: owner/manager OK; every other role → ForbiddenError; null → UnauthenticatedError', async () => {
    for (const role of ['owner', 'manager'] as const) {
      const member = await seedMemberWithRole(env.db, env.orgAId, role, `capw-${role}`);
      const sess = makeSession(env.orgAId, member.id, role);
      const result = await sendMemberMessageWithDb(env.db, sess, {
        subject: 'Cap check',
        body: 'Body text',
        audience: 'all_active',
      });
      expect(result.ok).toBe(true);
    }

    for (const role of ['dispatcher', 'cfi', 'mechanic', 'renter', 'student', 'accountant'] as const) {
      const member = await seedMemberWithRole(env.db, env.orgAId, role, `capw-deny-${role}`);
      const sess = makeSession(env.orgAId, member.id, role);
      await expect(
        sendMemberMessageWithDb(env.db, sess, {
          subject: 'Should be denied',
          body: 'Body text',
          audience: 'all_active',
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }

    await expect(
      sendMemberMessageWithDb(env.db, null, { subject: 'x', body: 'y', audience: 'all_active' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('previewMemberMessageRecipients + listMemberMessages: same gate', async () => {
    const dispatcher = await seedMemberWithRole(env.db, env.orgAId, 'dispatcher', 'cap-preview-deny');
    const sessDisp = makeSession(env.orgAId, dispatcher.id, 'dispatcher');
    await expect(
      previewMemberMessageRecipientsWithDb(env.db, sessDisp, { audience: 'all_active' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listMemberMessagesWithDb(env.db, sessDisp)).rejects.toBeInstanceOf(ForbiddenError);

    const owner = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      previewMemberMessageRecipientsWithDb(env.db, owner, { audience: 'all_active' }),
    ).resolves.toBeDefined();
    await expect(listMemberMessagesWithDb(env.db, owner)).resolves.toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ════════════════════════════════════════════════════════════════════════════

describe('sendMemberMessage — validation', () => {
  const sess = () => makeSession(env.orgAId, env.userAId, 'owner');

  it('empty subject → ValidationError', async () => {
    await expect(
      sendMemberMessageWithDb(env.db, sess(), { subject: '   ', body: 'Body', audience: 'all_active' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('empty body → ValidationError', async () => {
    await expect(
      sendMemberMessageWithDb(env.db, sess(), { subject: 'Subject', body: '   ', audience: 'all_active' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('subject over 200 chars → ValidationError', async () => {
    await expect(
      sendMemberMessageWithDb(env.db, sess(), {
        subject: 'x'.repeat(201),
        body: 'Body',
        audience: 'all_active',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('body over 5000 chars → ValidationError', async () => {
    await expect(
      sendMemberMessageWithDb(env.db, sess(), {
        subject: 'Subject',
        body: 'x'.repeat(5001),
        audience: 'all_active',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('invalid audience → ValidationError', async () => {
    await expect(
      sendMemberMessageWithDb(env.db, sess(), { subject: 'Subject', body: 'Body', audience: 'everyone' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('audience="role" missing role → ValidationError', async () => {
    await expect(
      sendMemberMessageWithDb(env.db, sess(), { subject: 'Subject', body: 'Body', audience: 'role' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('audience="role" with an invalid role string → ValidationError', async () => {
    await expect(
      sendMemberMessageWithDb(env.db, sess(), {
        subject: 'Subject',
        body: 'Body',
        audience: 'role',
        role: 'astronaut',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('audience="all_active" with a role set → ValidationError', async () => {
    await expect(
      sendMemberMessageWithDb(env.db, sess(), {
        subject: 'Subject',
        body: 'Body',
        audience: 'all_active',
        role: 'renter',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// RECIPIENT RESOLUTION
// ════════════════════════════════════════════════════════════════════════════

describe('recipient resolution', () => {
  it('all_active excludes inactive members', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const active = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'resolve-active', 'active');
    const inactive = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'resolve-inactive', 'inactive');

    const preview = await previewMemberMessageRecipientsWithDb(env.db, sess, { audience: 'all_active' });
    const result = await sendMemberMessageWithDb(env.db, sess, {
      subject: 'All active blast',
      body: 'Hello everyone',
      audience: 'all_active',
    });
    expect(result.recipientCount).toBe(preview.recipientCount);

    const logRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(notificationLog).where(eq(notificationLog.eventType, 'org.announcement')),
    );
    const notifiedIds = new Set(logRows.map((r) => r.userId));
    expect(notifiedIds.has(active.id)).toBe(true);
    expect(notifiedIds.has(inactive.id)).toBe(false);
  });

  it('audience="role" scopes to exactly that role', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const cfi = await seedMemberWithRole(env.db, env.orgAId, 'cfi', 'resolve-role-cfi');
    const student = await seedMemberWithRole(env.db, env.orgAId, 'student', 'resolve-role-student');

    const preview = await previewMemberMessageRecipientsWithDb(env.db, sess, {
      audience: 'role',
      role: 'cfi',
    });
    const result = await sendMemberMessageWithDb(env.db, sess, {
      subject: 'CFI-only blast',
      body: 'Hello CFIs',
      audience: 'role',
      role: 'cfi',
    });
    expect(result.recipientCount).toBe(preview.recipientCount);

    const logRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(notificationLog).where(eq(notificationLog.eventType, 'org.announcement')),
    );
    const notifiedIds = new Set(logRows.map((r) => r.userId));
    expect(notifiedIds.has(cfi.id)).toBe(true);
    expect(notifiedIds.has(student.id)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// OPT-OUTS + BEST-EFFORT BATCH
// ════════════════════════════════════════════════════════════════════════════

describe('opt-outs + best-effort batch behavior', () => {
  it('a member opted out of org.announcement is skipped, not sent, and does not abort the batch', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const optedOut = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'optout-member');
    const optedIn = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'optin-member');

    await setMyNotificationPrefWithDb(env.db, makeSession(env.orgAId, optedOut.id, 'renter'), {
      eventType: 'org.announcement',
      emailEnabled: false,
    });

    const result = await sendMemberMessageWithDb(env.db, sess, {
      subject: 'Opt-out probe',
      body: 'Testing opt-outs',
      audience: 'all_active',
    });

    expect(result.sentCount + result.skippedCount + result.failedCount).toBe(result.recipientCount);
    expect(result.skippedCount).toBeGreaterThanOrEqual(1);

    const logRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(notificationLog)
        .where(
          and(
            eq(notificationLog.eventType, 'org.announcement'),
            eq(notificationLog.userId, optedOut.id),
          ),
        ),
    );
    expect(logRows).toHaveLength(1);
    expect(logRows[0]!.status).toBe('skipped');

    const optedInLogRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(notificationLog)
        .where(
          and(
            eq(notificationLog.eventType, 'org.announcement'),
            eq(notificationLog.userId, optedIn.id),
          ),
        ),
    );
    expect(optedInLogRows).toHaveLength(1);
    expect(optedInLogRows[0]!.status).toBe('sent');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// member_message ROW + audit
// ════════════════════════════════════════════════════════════════════════════

describe('member_message row + audit', () => {
  it('recipient_count matches resolved recipients; ONE row per send; ONE audit_log row', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await seedMemberWithRole(env.db, env.orgAId, 'renter', 'row-check-1');
    await seedMemberWithRole(env.db, env.orgAId, 'renter', 'row-check-2');

    const preview = await previewMemberMessageRecipientsWithDb(env.db, sess, { audience: 'all_active' });
    const result = await sendMemberMessageWithDb(env.db, sess, {
      subject: 'Row check',
      body: 'Checking the row',
      audience: 'all_active',
    });

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(memberMessage).where(eq(memberMessage.id, result.messageId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientCount).toBe(preview.recipientCount);
    expect(rows[0]!.subject).toBe('Row check');
    expect(rows[0]!.audience).toBe('all_active');
    expect(rows[0]!.role).toBeNull();

    const audits = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, result.messageId), eq(auditLog.action, 'org.announcement_sent'))),
    );
    expect(audits).toHaveLength(1);
    // Privacy: audit metadata never carries the body.
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain('Checking the row');
  });

  it('listMemberMessages returns history newest-first', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await sendMemberMessageWithDb(env.db, sess, {
      subject: 'History 1',
      body: 'First',
      audience: 'all_active',
    });
    await sendMemberMessageWithDb(env.db, sess, {
      subject: 'History 2',
      body: 'Second',
      audience: 'all_active',
    });

    const history = await listMemberMessagesWithDb(env.db, sess);
    const subjects = history.map((m) => m.subject);
    expect(subjects.indexOf('History 2')).toBeLessThan(subjects.indexOf('History 1'));
  });

  it('append-only: UPDATE is denied under aeroops_app (FORCE RLS + no policy + REVOKE)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await sendMemberMessageWithDb(env.db, sess, {
      subject: 'Immutable check',
      body: 'Should never change',
      audience: 'all_active',
    });

    // No UPDATE RLS policy + REVOKE UPDATE (migration 0036) → aeroops_app
    // gets a hard permission-denied, not a silent 0-row no-op (mirrors
    // block_purchase's tested append-only posture).
    await expect(
      withOrgContext(env.db, env.orgAId, (tx) =>
        tx.update(memberMessage).set({ subject: 'Tampered' }).where(eq(memberMessage.id, result.messageId)),
      ),
    ).rejects.toThrow();

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(memberMessage).where(eq(memberMessage.id, result.messageId)),
    );
    expect(rows[0]!.subject).toBe('Immutable check');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BODY — plain text only, no HTML injection
// ════════════════════════════════════════════════════════════════════════════

describe('body is stored + sent as plain text (no HTML injection)', () => {
  it('a body containing markup is stored verbatim and escaped in the rendered html', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const injected = '<script>alert(1)</script> & "quotes" and \'apostrophes\'';

    const result = await sendMemberMessageWithDb(env.db, sess, {
      subject: 'Markup probe',
      body: injected,
      audience: 'all_active',
    });

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(memberMessage).where(eq(memberMessage.id, result.messageId)),
    );
    // Stored verbatim (no transformation) — the DB is not an HTML sanitizer.
    expect(rows[0]!.body).toBe(injected);

    const rendered = renderNotificationTemplate('org.announcement', {
      subject: 'Markup probe',
      body: injected,
      orgName: 'Test Org',
    });
    expect(rendered.text).toContain('<script>');
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// T-ISO
// ════════════════════════════════════════════════════════════════════════════

describe('T-ISO — tenant isolation', () => {
  it('org B members never receive org A\'s blast', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const memberB = await seedMemberWithRole(env.db, env.orgBId, 'renter', 'iso-member-b');

    await sendMemberMessageWithDb(env.db, sessA, {
      subject: 'Org A only',
      body: 'Should never reach org B',
      audience: 'all_active',
    });

    const rowsAsB = await withOrgContext(env.db, env.orgBId, (tx) =>
      tx.select().from(notificationLog).where(eq(notificationLog.eventType, 'org.announcement')),
    );
    expect(rowsAsB.some((r) => r.userId === memberB.id)).toBe(false);
  });

  it('listMemberMessages never returns another org\'s history', async () => {
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    await sendMemberMessageWithDb(env.db, sessB, {
      subject: 'Org B secret announcement',
      body: 'Only for org B',
      audience: 'all_active',
    });

    const historyA = await listMemberMessagesWithDb(env.db, makeSession(env.orgAId, env.userAId, 'owner'));
    expect(historyA.some((m) => m.subject === 'Org B secret announcement')).toBe(false);

    // Direct RLS check under org A's GUC.
    const rawA = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(memberMessage).where(eq(memberMessage.subject, 'Org B secret announcement')),
    );
    expect(rawA).toHaveLength(0);
  });
});
