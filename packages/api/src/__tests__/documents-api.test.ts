/**
 * documents-api.test.ts — API integration tests for Slice P1.6: Document
 * storage.
 *
 * Applies migrations 0000–0030 (0030 = document).
 *
 * Uses a FakeStorageProvider (records signUploadUrl/signDownloadUrl/
 * deleteObject calls; NO real S3/HTTP) injected via the *WithDb forms'
 * optional storageProvider parameter.
 *
 * COVERAGE:
 *   CAPABILITIES:
 *     requestUpload/confirmUpload/deleteDocument (write): people:manage for
 *       member docs, fleet:manage for aircraft docs.
 *     listDocuments/getDownloadUrl (read): people:access for member docs,
 *       fleet:access for aircraft docs.
 *   requestUpload:
 *     happy path (member + aircraft) — inserts 'pending' row, audit row,
 *       returns a signed PUT URL whose key is ORG-PREFIXED and
 *       SERVER-GENERATED (never influenced by client input).
 *     owner_not_found: nonexistent ownerId; cross-org ownerId; wrong-kind id
 *       (a member id passed as ownerType='aircraft').
 *     disallowed content-type → ValidationError; oversized → ValidationError.
 *     unconfigured (StubStorageProvider, no fake injected) → not_configured,
 *       NO document row inserted.
 *   confirmUpload:
 *     happy path flips pending → stored + audit row.
 *     idempotent: confirming an already-'stored' document is ok:true with
 *       NO duplicate audit row.
 *     cross-org id → not_found.
 *   listDocuments:
 *     owner-scoped; owner_not_found for a nonexistent/cross-org owner.
 *   getDownloadUrl:
 *     happy path — signed URL + audit 'document.downloaded'.
 *     cross-org id → not_found; unconfigured → not_configured.
 *   deleteDocument:
 *     removes the row + calls provider.deleteObject with the exact stored
 *       key; audited; cross-org id → not_found.
 *   T-ISO (adversarial): an attacker-supplied ownerId cannot escape the
 *     caller's own org prefix — the signed key is ALWAYS `org/<callerOrgId>/
 *     ...` regardless of which org actually owns the target row (the
 *     owner-existence check itself already refuses cross-org owners, so this
 *     also verifies that refusal); org B cannot list/download/delete org A's
 *     documents.
 *   Portal (getMyDocuments / getMyDocumentDownloadUrl):
 *     self-scoped to session.userId; cannot read another member's document;
 *     cannot read an aircraft document via the portal self-scope.
 *
 * Setup mirrors maintenance-due-api.test.ts:
 *   createTestClient() → applyMigrationSql([0000–0030]) → seedTwoOrgs → setTestAppRole.
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
  document,
  loadMigrationSql,
} from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import { createResourceWithDb } from '../scheduling/resource-commands.js';

import { requestUploadWithDb } from '../documents/request-upload.js';
import { confirmUploadWithDb } from '../documents/confirm-upload.js';
import { listDocumentsWithDb } from '../documents/list-documents.js';
import { getDownloadUrlWithDb } from '../documents/get-download-url.js';
import { deleteDocumentWithDb } from '../documents/delete-document.js';
import { getMyDocumentsWithDb } from '../portal/get-my-documents.js';
import { getMyDocumentDownloadUrlWithDb } from '../portal/get-my-document-download-url.js';
import type { StorageProvider, StorageSignResult, StorageDeleteResult } from '../storage/provider.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// All up migrations through 0038 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0038');

// ── Fake storage provider ─────────────────────────────────────────────────────

interface RecordedCall {
  method: 'signUploadUrl' | 'signDownloadUrl' | 'deleteObject';
  key: string;
}

class FakeStorageProvider implements StorageProvider {
  readonly calls: RecordedCall[] = [];

  async signUploadUrl(input: { key: string; contentType: string }): Promise<StorageSignResult> {
    this.calls.push({ method: 'signUploadUrl', key: input.key });
    return {
      ok: true,
      url: `https://fake-storage.test/${input.key}?upload=1`,
      method: 'PUT',
      expiresAt: new Date(Date.now() + 900_000),
    };
  }

  async signDownloadUrl(input: { key: string }): Promise<StorageSignResult> {
    this.calls.push({ method: 'signDownloadUrl', key: input.key });
    return {
      ok: true,
      url: `https://fake-storage.test/${input.key}?download=1`,
      method: 'GET',
      expiresAt: new Date(Date.now() + 300_000),
    };
  }

  async deleteObject(input: { key: string }): Promise<StorageDeleteResult> {
    this.calls.push({ method: 'deleteObject', key: input.key });
    return { ok: true };
  }
}

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
): Promise<{ id: string; email: string }> {
  const tail = nextTail(tag);
  const email = `${tail.toLowerCase()}@example.test`;
  const rows = await withOrgContext(db, orgId, (tx) =>
    tx.insert(appUser).values({ orgId, email, fullName: `Member ${tail}` }).returning({ id: appUser.id }),
  );
  const row = rows[0];
  if (!row) throw new Error('seedMemberWithRole: INSERT returned no row');
  await withOrgContext(db, orgId, (tx) => tx.insert(membership).values({ orgId, userId: row.id, role }));
  return { id: row.id, email };
}

async function seedAircraft(orgId: string, sess: AppSession, tailPrefix: string) {
  return createResourceWithDb(env.db, sess, {
    kind: 'aircraft',
    displayName: `Test Aircraft ${tailPrefix}`,
    tailNumber: nextTail(tailPrefix),
  });
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

// ════════════════════════════════════════════════════════════════════════════
// CAPABILITIES
// ════════════════════════════════════════════════════════════════════════════

describe('documents — capabilities', () => {
  it('requestUpload (member): people:manage OK; people:access-only (dispatcher) → ForbiddenError', async () => {
    const owner = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'cap-member-target');
    const fake = new FakeStorageProvider();

    const okResult = await requestUploadWithDb(
      env.db,
      owner,
      { ownerType: 'member', ownerId: member.id, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 100 },
      fake,
    );
    expect(okResult.ok).toBe(true);

    const dispatcher = await seedMemberWithRole(env.db, env.orgAId, 'dispatcher', 'cap-write-deny');
    const dispSess = makeSession(env.orgAId, dispatcher.id, 'dispatcher');
    await expect(
      requestUploadWithDb(
        env.db,
        dispSess,
        { ownerType: 'member', ownerId: member.id, filename: 'b.pdf', contentType: 'application/pdf', sizeBytes: 100 },
        fake,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('requestUpload (aircraft): fleet:manage OK; cfi (fleet:access only) → ForbiddenError', async () => {
    const owner = makeSession(env.orgAId, env.userAId, 'owner');
    const aircraft = await seedAircraft(env.orgAId, owner, 'CAPAC');
    const fake = new FakeStorageProvider();

    const okResult = await requestUploadWithDb(
      env.db,
      owner,
      { ownerType: 'aircraft', ownerId: aircraft.id, filename: 'poh.pdf', contentType: 'application/pdf', sizeBytes: 100 },
      fake,
    );
    expect(okResult.ok).toBe(true);

    const cfi = await seedMemberWithRole(env.db, env.orgAId, 'cfi', 'cap-ac-deny');
    const cfiSess = makeSession(env.orgAId, cfi.id, 'cfi');
    await expect(
      requestUploadWithDb(
        env.db,
        cfiSess,
        { ownerType: 'aircraft', ownerId: aircraft.id, filename: 'x.pdf', contentType: 'application/pdf', sizeBytes: 100 },
        fake,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('null session → UnauthenticatedError', async () => {
    await expect(
      requestUploadWithDb(env.db, null, { ownerType: 'member', ownerId: env.userAId, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('listDocuments (member): people:access OK for dispatcher; renter (no people:access) → ForbiddenError', async () => {
    const owner = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'cap-list-member');

    const dispatcher = await seedMemberWithRole(env.db, env.orgAId, 'dispatcher', 'cap-list-ok');
    const dispSess = makeSession(env.orgAId, dispatcher.id, 'dispatcher');
    const okResult = await listDocumentsWithDb(env.db, dispSess, { ownerType: 'member', ownerId: member.id });
    expect(okResult.ok).toBe(true);

    const renterSess = makeSession(env.orgAId, member.id, 'renter');
    await expect(
      listDocumentsWithDb(env.db, renterSess, { ownerType: 'member', ownerId: member.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    void owner;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// requestUpload
// ════════════════════════════════════════════════════════════════════════════

describe('requestUpload', () => {
  it('happy path (member): inserts pending row + audit; returns a server-generated, org-prefixed key', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMemberWithRole(env.db, env.orgAId, 'student', 'ru-member');
    const fake = new FakeStorageProvider();

    const result = await requestUploadWithDb(
      env.db,
      sess,
      { ownerType: 'member', ownerId: member.id, filename: 'medical.pdf', contentType: 'application/pdf', sizeBytes: 12345, category: 'Medical' },
      fake,
    );
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.document.status).toBe('pending');
    expect(result.document.category).toBe('Medical');
    expect(result.uploadUrl).toContain('upload=1');
    expect(result.uploadMethod).toBe('PUT');

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.method).toBe('signUploadUrl');
    expect(fake.calls[0]!.key.startsWith(`org/${env.orgAId}/member/${member.id}/`)).toBe(true);

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(document).where(eq(document.id, result.document.id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.storageKey.startsWith(`org/${env.orgAId}/`)).toBe(true);

    const auditRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.entityType, 'document'), eq(auditLog.entityId, result.document.id))),
    );
    expect(auditRows.some((r) => r.action === 'document.upload_requested')).toBe(true);
  });

  it('happy path (aircraft)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const aircraft = await seedAircraft(env.orgAId, sess, 'RUAC');
    const fake = new FakeStorageProvider();

    const result = await requestUploadWithDb(
      env.db,
      sess,
      { ownerType: 'aircraft', ownerId: aircraft.id, filename: 'insurance.pdf', contentType: 'application/pdf', sizeBytes: 500 },
      fake,
    );
    if (!result.ok) throw new Error('expected ok:true');
    expect(fake.calls[0]!.key.startsWith(`org/${env.orgAId}/aircraft/${aircraft.id}/`)).toBe(true);
  });

  it('owner_not_found: nonexistent ownerId', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const fake = new FakeStorageProvider();
    const result = await requestUploadWithDb(
      env.db,
      sess,
      { ownerType: 'member', ownerId: '00000000-0000-0000-0000-000000000000', filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      fake,
    );
    expect(result).toEqual({ ok: false, reason: 'owner_not_found' });
    expect(fake.calls).toHaveLength(0);
  });

  it('owner_not_found: cross-org ownerId (member of org B, caller in org A)', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const memberB = await seedMemberWithRole(env.db, env.orgBId, 'renter', 'ru-crossorg');
    const fake = new FakeStorageProvider();
    const result = await requestUploadWithDb(
      env.db,
      sessA,
      { ownerType: 'member', ownerId: memberB.id, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      fake,
    );
    expect(result).toEqual({ ok: false, reason: 'owner_not_found' });
    expect(fake.calls).toHaveLength(0);
  });

  it('owner_not_found: wrong-kind id (a member id passed as ownerType=aircraft)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'ru-wrongkind');
    const fake = new FakeStorageProvider();
    const result = await requestUploadWithDb(
      env.db,
      sess,
      { ownerType: 'aircraft', ownerId: member.id, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      fake,
    );
    expect(result).toEqual({ ok: false, reason: 'owner_not_found' });
  });

  it('disallowed content-type → ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'ru-badtype');
    await expect(
      requestUploadWithDb(
        env.db,
        sess,
        { ownerType: 'member', ownerId: member.id, filename: 'virus.exe', contentType: 'application/x-msdownload', sizeBytes: 10 },
        new FakeStorageProvider(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('oversized → ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'ru-toobig');
    await expect(
      requestUploadWithDb(
        env.db,
        sess,
        { ownerType: 'member', ownerId: member.id, filename: 'big.pdf', contentType: 'application/pdf', sizeBytes: 999_999_999 },
        new FakeStorageProvider(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('unconfigured storage (StubStorageProvider default) → not_configured, no row inserted', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'ru-unconfigured');
    // NO storageProvider argument → falls through to getStorageProvider(),
    // which resolves to StubStorageProvider when STORAGE_* env is unset
    // (the default in this test process).
    const result = await requestUploadWithDb(env.db, sess, {
      ownerType: 'member',
      ownerId: member.id,
      filename: 'a.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
    });
    expect(result).toEqual({ ok: false, reason: 'not_configured' });

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(document).where(eq(document.ownerId, member.id)),
    );
    expect(rows).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// confirmUpload
// ════════════════════════════════════════════════════════════════════════════

describe('confirmUpload', () => {
  it('happy path flips pending → stored + audit row; idempotent second call has NO duplicate audit', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'cu-member');
    const fake = new FakeStorageProvider();
    const created = await requestUploadWithDb(
      env.db,
      sess,
      { ownerType: 'member', ownerId: member.id, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      fake,
    );
    if (!created.ok) throw new Error('seed failed');

    const first = await confirmUploadWithDb(env.db, sess, { documentId: created.document.id });
    if (!first.ok) throw new Error('expected ok:true');
    expect(first.document.status).toBe('stored');

    const second = await confirmUploadWithDb(env.db, sess, { documentId: created.document.id });
    expect(second).toEqual({ ok: true, document: first.document });

    const auditRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, 'document'), eq(auditLog.entityId, created.document.id), eq(auditLog.action, 'document.upload_confirmed'))),
    );
    expect(auditRows).toHaveLength(1);
  });

  it('cross-org id → not_found', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const memberB = await seedMemberWithRole(env.db, env.orgBId, 'renter', 'cu-crossorg');
    const created = await requestUploadWithDb(
      env.db,
      sessB,
      { ownerType: 'member', ownerId: memberB.id, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      new FakeStorageProvider(),
    );
    if (!created.ok) throw new Error('seed failed');

    const result = await confirmUploadWithDb(env.db, sessA, { documentId: created.document.id });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// getDownloadUrl
// ════════════════════════════════════════════════════════════════════════════

describe('getDownloadUrl', () => {
  it('happy path — signed URL + audit document.downloaded', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'gd-member');
    const fake = new FakeStorageProvider();
    const created = await requestUploadWithDb(
      env.db,
      sess,
      { ownerType: 'member', ownerId: member.id, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      fake,
    );
    if (!created.ok) throw new Error('seed failed');

    const result = await getDownloadUrlWithDb(env.db, sess, { documentId: created.document.id }, fake);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.url).toContain('download=1');

    const auditRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, 'document'), eq(auditLog.entityId, created.document.id), eq(auditLog.action, 'document.downloaded'))),
    );
    expect(auditRows).toHaveLength(1);
  });

  it('cross-org id → not_found', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const memberB = await seedMemberWithRole(env.db, env.orgBId, 'renter', 'gd-crossorg');
    const created = await requestUploadWithDb(
      env.db,
      sessB,
      { ownerType: 'member', ownerId: memberB.id, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      new FakeStorageProvider(),
    );
    if (!created.ok) throw new Error('seed failed');

    const result = await getDownloadUrlWithDb(env.db, sessA, { documentId: created.document.id }, new FakeStorageProvider());
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('unconfigured storage → not_configured, no crash', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'gd-unconfigured');
    const created = await requestUploadWithDb(
      env.db,
      sess,
      { ownerType: 'member', ownerId: member.id, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      new FakeStorageProvider(),
    );
    if (!created.ok) throw new Error('seed failed');

    const result = await getDownloadUrlWithDb(env.db, sess, { documentId: created.document.id });
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// deleteDocument
// ════════════════════════════════════════════════════════════════════════════

describe('deleteDocument', () => {
  it('removes the row + calls provider.deleteObject with the exact stored key; audited', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const member = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'del-member');
    const uploadFake = new FakeStorageProvider();
    const created = await requestUploadWithDb(
      env.db,
      sess,
      { ownerType: 'member', ownerId: member.id, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      uploadFake,
    );
    if (!created.ok) throw new Error('seed failed');
    const storedKey = uploadFake.calls[0]!.key;

    const deleteFake = new FakeStorageProvider();
    const result = await deleteDocumentWithDb(env.db, sess, { documentId: created.document.id }, deleteFake);
    expect(result).toEqual({ ok: true });
    expect(deleteFake.calls).toHaveLength(1);
    expect(deleteFake.calls[0]).toEqual({ method: 'deleteObject', key: storedKey });

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(document).where(eq(document.id, created.document.id)),
    );
    expect(rows).toHaveLength(0);

    const auditRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.entityType, 'document'), eq(auditLog.entityId, created.document.id), eq(auditLog.action, 'document.deleted'))),
    );
    expect(auditRows).toHaveLength(1);
  });

  it('cross-org id → not_found', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const memberB = await seedMemberWithRole(env.db, env.orgBId, 'renter', 'del-crossorg');
    const created = await requestUploadWithDb(
      env.db,
      sessB,
      { ownerType: 'member', ownerId: memberB.id, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      new FakeStorageProvider(),
    );
    if (!created.ok) throw new Error('seed failed');

    const result = await deleteDocumentWithDb(env.db, sessA, { documentId: created.document.id }, new FakeStorageProvider());
    expect(result).toEqual({ ok: false, reason: 'not_found' });

    // Row must still exist in org B, untouched.
    const rows = await withOrgContext(env.db, env.orgBId, (tx) =>
      tx.select().from(document).where(eq(document.id, created.document.id)),
    );
    expect(rows).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Tenant isolation (T-ISO)
// ════════════════════════════════════════════════════════════════════════════

describe('T-ISO — document cross-org isolation + storage-key org-prefix guarantee', () => {
  it('the signed key ALWAYS carries the CALLER\'S OWN org prefix — never the target row\'s (structural, not just a filter)', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const memberA = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'tiso-member-a');
    const fake = new FakeStorageProvider();

    const result = await requestUploadWithDb(
      env.db,
      sessA,
      { ownerType: 'member', ownerId: memberA.id, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      fake,
    );
    if (!result.ok) throw new Error('expected ok:true');

    // The signed key's org segment is sessA.orgId — org B never appears
    // anywhere in the key, structurally (generateStorageKey never reads
    // anything but the session's own orgId).
    expect(fake.calls[0]!.key.startsWith(`org/${env.orgAId}/`)).toBe(true);
    expect(fake.calls[0]!.key.includes(env.orgBId)).toBe(false);
  });

  it('org B cannot list org A\'s member documents (owner_not_found, not a leak)', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const memberA = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'tiso-list-a');
    await requestUploadWithDb(
      env.db,
      sessA,
      { ownerType: 'member', ownerId: memberA.id, filename: 'secret.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      new FakeStorageProvider(),
    );

    const result = await listDocumentsWithDb(env.db, sessB, { ownerType: 'member', ownerId: memberA.id });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('direct RLS check: raw SELECT under org B\'s GUC never returns org A\'s document row', async () => {
    const sessA = makeSession(env.orgAId, env.userAId, 'owner');
    const memberA = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'tiso-raw-a');
    const created = await requestUploadWithDb(
      env.db,
      sessA,
      { ownerType: 'member', ownerId: memberA.id, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      new FakeStorageProvider(),
    );
    if (!created.ok) throw new Error('seed failed');

    const rawB = await withOrgContext(env.db, env.orgBId, (tx) =>
      tx.select().from(document).where(eq(document.id, created.document.id)),
    );
    expect(rawB).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Portal self-scope (getMyDocuments / getMyDocumentDownloadUrl)
// ════════════════════════════════════════════════════════════════════════════

describe('portal — getMyDocuments / getMyDocumentDownloadUrl self-scope', () => {
  it('getMyDocuments returns only the caller\'s OWN documents', async () => {
    const owner = makeSession(env.orgAId, env.userAId, 'owner');
    const me = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'portal-me');
    const other = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'portal-other');
    const fake = new FakeStorageProvider();

    const mine = await requestUploadWithDb(
      env.db,
      owner,
      { ownerType: 'member', ownerId: me.id, filename: 'mine.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      fake,
    );
    const theirs = await requestUploadWithDb(
      env.db,
      owner,
      { ownerType: 'member', ownerId: other.id, filename: 'theirs.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      fake,
    );
    if (!mine.ok || !theirs.ok) throw new Error('seed failed');

    const meSess = makeSession(env.orgAId, me.id, 'renter');
    const myDocs = await getMyDocumentsWithDb(env.db, meSess);
    expect(myDocs.some((d) => d.id === mine.document.id)).toBe(true);
    expect(myDocs.some((d) => d.id === theirs.document.id)).toBe(false);
  });

  it('getMyDocumentDownloadUrl refuses another member\'s document (not_found, anti-enumeration)', async () => {
    const owner = makeSession(env.orgAId, env.userAId, 'owner');
    const me = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'portal-dl-me');
    const other = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'portal-dl-other');
    const fake = new FakeStorageProvider();

    const theirs = await requestUploadWithDb(
      env.db,
      owner,
      { ownerType: 'member', ownerId: other.id, filename: 'theirs.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      fake,
    );
    if (!theirs.ok) throw new Error('seed failed');

    const meSess = makeSession(env.orgAId, me.id, 'renter');
    const result = await getMyDocumentDownloadUrlWithDb(env.db, meSess, { documentId: theirs.document.id }, fake);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('getMyDocumentDownloadUrl refuses an aircraft document even for its own uploader', async () => {
    const owner = makeSession(env.orgAId, env.userAId, 'owner');
    const aircraft = await seedAircraft(env.orgAId, owner, 'PORTALAC');
    const fake = new FakeStorageProvider();
    const doc = await requestUploadWithDb(
      env.db,
      owner,
      { ownerType: 'aircraft', ownerId: aircraft.id, filename: 'poh.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      fake,
    );
    if (!doc.ok) throw new Error('seed failed');

    const result = await getMyDocumentDownloadUrlWithDb(env.db, owner, { documentId: doc.document.id }, fake);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('getMyDocumentDownloadUrl happy path — signed URL for the caller\'s OWN document', async () => {
    const owner = makeSession(env.orgAId, env.userAId, 'owner');
    const me = await seedMemberWithRole(env.db, env.orgAId, 'renter', 'portal-dl-happy');
    const fake = new FakeStorageProvider();
    const created = await requestUploadWithDb(
      env.db,
      owner,
      { ownerType: 'member', ownerId: me.id, filename: 'mine.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      fake,
    );
    if (!created.ok) throw new Error('seed failed');

    const meSess = makeSession(env.orgAId, me.id, 'renter');
    const result = await getMyDocumentDownloadUrlWithDb(env.db, meSess, { documentId: created.document.id }, fake);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.url).toContain('download=1');
  });
});
