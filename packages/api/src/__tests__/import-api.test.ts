/**
 * import-api.test.ts — Integration tests for Slice P1.7: Flight Circle
 * data importer.
 *
 * Applies migrations 0000–0027. Every write goes through the REAL
 * previewImportWithDb / commitImportWithDb / listImportBatchesWithDb /
 * getImportBatchWithDb — no bespoke SQL bypasses the command layer.
 *
 * COVERAGE:
 *   1. previewImport: happy path (members) — stages rows, no real app_user
 *      created, batch status='previewed'.
 *   2. previewImport: happy path (aircraft) — stages rows, no real resource
 *      created.
 *   3. previewImport: duplicate-by-email against an EXISTING member is
 *      flagged 'skipped' at staging time (not silently imported later).
 *   4. previewImport: duplicate-by-tail against an EXISTING aircraft is
 *      flagged 'skipped'.
 *   5. previewImport: a malformed row (invalid email) is staged 'error',
 *      others stay 'pending'.
 *   6. previewImport: guessColumnMapping is used when no mapping supplied.
 *   7. previewImport: a Sales-Transactions-shaped CSV is staged out-of-scope
 *      (batch.errorDetail set, every row 'error').
 *   8. commitImport: creates members via the REAL addMember path (NO
 *      auth_credential row) + updates import_row target_id/status + batch
 *      counts/status.
 *   9. commitImport: creates aircraft via createResource + updateAircraft
 *      (identity fields land on resource).
 *  10. commitImport: a row that duplicates an existing record at COMMIT time
 *      (created after preview) is skipped, not overwritten.
 *  11. commitImport: a malformed/erroring row does not abort the batch —
 *      other rows still commit.
 *  12. commitImport: already-committed batch → refused, no double-import.
 *  13. commitImport: out-of-scope batch → refused with the staged message.
 *  14. commitImport: not-found / not-previewed refusals.
 *  15. Tenant isolation (T-ISO): org B cannot see org A's import_batch/
 *      import_row via listImportBatches/getImportBatch.
 *  16. Capabilities: wrong role → ForbiddenError for preview/commit/list/get,
 *      gated per kind (people:* for members, fleet:* for aircraft).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  appUser,
  authCredential,
  resource,
  importBatch,
  importRow,
  loadMigrationSql,
} from '@aeroops/db';
import { eq, and } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';
import type { PGlite } from '@electric-sql/pglite';

import { previewImportWithDb } from '../import/preview-import.js';
import { commitImportWithDb } from '../import/commit-import.js';
import { listImportBatchesWithDb } from '../import/list-import-batches.js';
import { getImportBatchWithDb } from '../import/get-import-batch.js';

import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import { ValidationError } from '../scheduling/internal.js';
import type { AppSession } from '../auth/types.js';

// All up migrations through 0043 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0043');

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

// ── CSV fixtures ────────────────────────────────────────────────────────────

const MEMBERS_CSV =
  'Full Name,Email Address,Phone Number\n' +
  'Alice Anderson,alice@example.test,555-0001\n' +
  'Bob Baker,bob@example.test,555-0002\n';

const AIRCRAFT_CSV =
  'Tail Number,Make,Model,Year,Serial Number\n' +
  'N100AB,Cessna,172S,2015,17280001\n' +
  'N200CD,Piper,PA-28,2010,28001234\n';

const SALES_TRANSACTIONS_CSV =
  'Date,Transaction Type,Amount,Balance\n' + '2026-01-01,Charge,150.00,150.00\n';

// myFBO-shaped export: different header wording than Flight Circle. The
// operator-confirmed column-mapping step (auto-guessed here) is what bridges
// the difference — the parse/normalize/write path is identical per source.
const MYFBO_MEMBERS_CSV =
  'Member Name,E-mail,Cell Phone,Member Type\n' +
  'Dana Diaz,dana-myfbo@example.test,555-0100,Student\n' +
  'Evan Ent,evan-myfbo@example.test,555-0101,Renter\n';

async function seedExistingMember(orgId: string, email: string): Promise<void> {
  await withOrgContext(env.db, orgId, (tx) =>
    tx.insert(appUser).values({ orgId, email, fullName: 'Existing Member' }),
  );
}

async function seedExistingAircraft(orgId: string, tailNumber: string): Promise<void> {
  await withOrgContext(env.db, orgId, (tx) =>
    tx.insert(resource).values({ orgId, kind: 'aircraft', displayName: tailNumber, tailNumber }),
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// 1–2. previewImport — happy path
// ════════════════════════════════════════════════════════════════════════════════

describe('previewImport — happy path', () => {
  it('members: stages rows, creates no real app_user, batch status=previewed', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await previewImportWithDb(env.db, session, {
      kind: 'members',
      filename: 'members.csv',
      csvText: MEMBERS_CSV,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.batch.status).toBe('previewed');
    expect(result.batch.kind).toBe('members');
    expect(result.batch.rowCount).toBe(2);
    expect(result.outOfScope).toBe(false);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.status === 'pending')).toBe(true);

    // No real record created yet.
    const found = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(appUser).where(eq(appUser.email, 'alice@example.test')),
    );
    expect(found).toHaveLength(0);
  });

  it('aircraft: stages rows, creates no real resource, batch status=previewed', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await previewImportWithDb(env.db, session, {
      kind: 'aircraft',
      filename: 'aircraft.csv',
      csvText: AIRCRAFT_CSV,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.batch.status).toBe('previewed');
    expect(result.batch.kind).toBe('aircraft');
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.status === 'pending')).toBe(true);
    // guessColumnMapping should have found the columns.
    expect(result.mapping['tailNumber']).toBe('Tail Number');
    expect(result.mapping['make']).toBe('Make');

    const found = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(resource).where(eq(resource.tailNumber, 'N100AB')),
    );
    expect(found).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3–4. previewImport — duplicate detection at staging time
// ════════════════════════════════════════════════════════════════════════════════

describe('previewImport — duplicate detection', () => {
  it('flags a member row as skipped when the email already exists in the org', async () => {
    await seedExistingMember(env.orgAId, 'dup-preview@example.test');
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await previewImportWithDb(env.db, session, {
      kind: 'members',
      filename: 'dup.csv',
      csvText: 'Full Name,Email Address\nDup Person,dup-preview@example.test\n',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]!.status).toBe('skipped');
  });

  it('flags an aircraft row as skipped when the tail already exists in the org', async () => {
    await seedExistingAircraft(env.orgAId, 'N999ZZ');
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await previewImportWithDb(env.db, session, {
      kind: 'aircraft',
      filename: 'dup-aircraft.csv',
      csvText: 'Tail Number,Make\nN999ZZ,Cessna\n',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]!.status).toBe('skipped');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5–6. previewImport — malformed rows + mapping
// ════════════════════════════════════════════════════════════════════════════════

describe('previewImport — malformed rows', () => {
  it('stages an invalid-email row as error while valid rows stay pending', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const csv = 'Full Name,Email Address\nGood,good1@example.test\nBad,not-an-email\n';
    const result = await previewImportWithDb(env.db, session, {
      kind: 'members',
      filename: 'mixed.csv',
      csvText: csv,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]!.status).toBe('pending');
    expect(result.rows[1]!.status).toBe('error');
    expect(result.rows[1]!.errorDetail).toBe('invalid_email');
  });

  it('empty CSV returns ok:false reason:empty_csv', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await previewImportWithDb(env.db, session, {
      kind: 'members',
      filename: 'empty.csv',
      csvText: 'Full Name,Email Address\n',
    });
    expect(result).toEqual({ ok: false, reason: 'empty_csv' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 7. previewImport — out-of-scope Sales Transactions detection
// ════════════════════════════════════════════════════════════════════════════════

describe('previewImport — out-of-scope ledger detection', () => {
  it('stages a Sales-Transactions-shaped file as out-of-scope', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await previewImportWithDb(env.db, session, {
      kind: 'members',
      filename: 'sales.csv',
      csvText: SALES_TRANSACTIONS_CSV,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outOfScope).toBe(true);
    expect(result.batch.outOfScope).toBe(true);
    expect(result.batch.errorDetail).toMatch(/out_of_scope/);
    expect(result.rows.every((r) => r.status === 'error')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 7b. Source label — myFBO / other / default flight_circle
// ════════════════════════════════════════════════════════════════════════════════

describe('previewImport — migration source label', () => {
  it('persists source=myfbo and auto-guesses myFBO-shaped member headers', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await previewImportWithDb(env.db, session, {
      kind: 'members',
      source: 'myfbo',
      filename: 'myfbo-members.csv',
      csvText: MYFBO_MEMBERS_CSV,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.batch.source).toBe('myfbo');
    // guessColumnMapping bridged the different header wording.
    expect(result.mapping['email']).toBe('E-mail');
    expect(result.mapping['fullName']).toBe('Member Name');
    expect(result.mapping['phone']).toBe('Cell Phone');
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.status === 'pending')).toBe(true);

    // The source label is persisted on the row, and it satisfies migration
    // 0043's widened import_batch_source_check.
    const batchRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(importBatch).where(eq(importBatch.id, result.batch.id)),
    );
    expect(batchRows[0]!.source).toBe('myfbo');
  });

  it('defaults source to flight_circle when omitted', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await previewImportWithDb(env.db, session, {
      kind: 'members',
      filename: 'default-source.csv',
      csvText: 'Full Name,Email Address\nSam Source,sam-source@example.test\n',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.batch.source).toBe('flight_circle');
  });

  it('rejects an unknown source value with a ValidationError', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      previewImportWithDb(env.db, session, {
        kind: 'members',
        source: 'bogus_source',
        filename: 'bad-source.csv',
        csvText: MEMBERS_CSV,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('commits a myFBO-sourced batch through the SAME write path (real app_users)', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const preview = await previewImportWithDb(env.db, session, {
      kind: 'members',
      source: 'myfbo',
      filename: 'myfbo-commit.csv',
      csvText:
        'Member Name,E-mail,Cell Phone\n' +
        'Faye Fox,faye-myfbo@example.test,555-0200\n',
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const commit = await commitImportWithDb(env.db, session, { batchId: preview.batch.id });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    expect(commit.batch.source).toBe('myfbo');
    expect(commit.batch.importedCount).toBe(1);

    const users = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(appUser).where(eq(appUser.email, 'faye-myfbo@example.test')),
    );
    expect(users).toHaveLength(1);
    expect(users[0]!.fullName).toBe('Faye Fox');
    expect(users[0]!.phone).toBe('555-0200');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 8–9. commitImport — real records via the real write paths
// ════════════════════════════════════════════════════════════════════════════════

describe('commitImport — creates real records via existing write paths', () => {
  it('members: creates app_user via addMember, NO auth_credential, updates row + batch', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const csv = 'Full Name,Email Address,Phone\nCarol Commit,carol-commit@example.test,555-9999\n';
    const preview = await previewImportWithDb(env.db, session, {
      kind: 'members',
      filename: 'commit-members.csv',
      csvText: csv,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const commit = await commitImportWithDb(env.db, session, { batchId: preview.batch.id });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    expect(commit.batch.status).toBe('committed');
    expect(commit.batch.importedCount).toBe(1);
    expect(commit.results).toHaveLength(1);
    expect(commit.results[0]!.status).toBe('imported');
    const targetId = commit.results[0]!.targetId;
    expect(targetId).toBeTruthy();

    const users = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(appUser).where(eq(appUser.email, 'carol-commit@example.test')),
    );
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe(targetId);

    const creds = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(authCredential).where(eq(authCredential.userId, targetId!)),
    );
    expect(creds).toHaveLength(0);

    // import_row updated in place.
    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(importRow).where(eq(importRow.importBatchId, preview.batch.id)),
    );
    expect(rows[0]!.mappedStatus).toBe('imported');
    expect(rows[0]!.targetId).toBe(targetId);
  });

  it('aircraft: creates resource via createResource + updateAircraft (identity fields land)', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const csv = 'Tail Number,Make,Model,Year,Serial Number\nN300EF,Cessna,182,2018,18200099\n';
    const preview = await previewImportWithDb(env.db, session, {
      kind: 'aircraft',
      filename: 'commit-aircraft.csv',
      csvText: csv,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const commit = await commitImportWithDb(env.db, session, { batchId: preview.batch.id });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    expect(commit.batch.importedCount).toBe(1);
    const targetId = commit.results[0]!.targetId;

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(resource).where(eq(resource.tailNumber, 'N300EF')),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(targetId);
    expect(rows[0]!.make).toBe('Cessna');
    expect(rows[0]!.model).toBe('182');
    expect(rows[0]!.year).toBe(2018);
    expect(rows[0]!.serialNumber).toBe('18200099');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 10. commitImport — duplicate surfaced only at commit time is skipped
// ════════════════════════════════════════════════════════════════════════════════

describe('commitImport — commit-time duplicate is skipped, not overwritten', () => {
  it('a member created AFTER preview but before commit is skipped at commit', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const csv = 'Full Name,Email Address\nRace Person,race@example.test\n';
    const preview = await previewImportWithDb(env.db, session, {
      kind: 'members',
      filename: 'race.csv',
      csvText: csv,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    // Simulate a concurrent create between preview and commit.
    await seedExistingMember(env.orgAId, 'race@example.test');

    const commit = await commitImportWithDb(env.db, session, { batchId: preview.batch.id });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    expect(commit.batch.importedCount).toBe(0);
    expect(commit.batch.skippedCount).toBe(1);
    expect(commit.results[0]!.status).toBe('skipped');

    // Still exactly ONE app_user with this email (not duplicated).
    const users = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(appUser).where(eq(appUser.email, 'race@example.test')),
    );
    expect(users).toHaveLength(1);
  });

  it('an aircraft tail created AFTER preview but before commit is skipped at commit', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const csv = 'Tail Number,Make\nN400GH,Cessna\n';
    const preview = await previewImportWithDb(env.db, session, {
      kind: 'aircraft',
      filename: 'race-aircraft.csv',
      csvText: csv,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    await seedExistingAircraft(env.orgAId, 'N400GH');

    const commit = await commitImportWithDb(env.db, session, { batchId: preview.batch.id });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    expect(commit.batch.importedCount).toBe(0);
    expect(commit.batch.skippedCount).toBe(1);

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(resource).where(eq(resource.tailNumber, 'N400GH')),
    );
    expect(rows).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 11. commitImport — a bad row does not abort the batch
// ════════════════════════════════════════════════════════════════════════════════

describe('commitImport — a bad row skips, does not abort the batch', () => {
  it('one invalid row errors while the other row still imports', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const csv =
      'Full Name,Email Address\n' + 'Good Row,good-batch@example.test\n' + 'Bad Row,not-an-email\n';
    const preview = await previewImportWithDb(env.db, session, {
      kind: 'members',
      filename: 'partial.csv',
      csvText: csv,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const commit = await commitImportWithDb(env.db, session, { batchId: preview.batch.id });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    expect(commit.batch.importedCount).toBe(1);
    expect(commit.batch.skippedCount).toBe(1);

    const users = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(appUser).where(eq(appUser.email, 'good-batch@example.test')),
    );
    expect(users).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 12–14. commitImport — refusals
// ════════════════════════════════════════════════════════════════════════════════

describe('commitImport — refusals', () => {
  it('an already-committed batch is refused (no double-import)', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const csv = 'Full Name,Email Address\nOnce,once@example.test\n';
    const preview = await previewImportWithDb(env.db, session, {
      kind: 'members',
      filename: 'once.csv',
      csvText: csv,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const first = await commitImportWithDb(env.db, session, { batchId: preview.batch.id });
    expect(first.ok).toBe(true);

    const second = await commitImportWithDb(env.db, session, { batchId: preview.batch.id });
    expect(second).toEqual({ ok: false, reason: 'already_committed' });

    const users = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(appUser).where(eq(appUser.email, 'once@example.test')),
    );
    expect(users).toHaveLength(1);
  });

  it('an out-of-scope batch is refused with the staged message', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const preview = await previewImportWithDb(env.db, session, {
      kind: 'members',
      filename: 'sales-commit.csv',
      csvText: SALES_TRANSACTIONS_CSV,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const commit = await commitImportWithDb(env.db, session, { batchId: preview.batch.id });
    expect(commit.ok).toBe(false);
    if (commit.ok) return;
    expect(commit.reason).toBe('out_of_scope');
  });

  it('a non-existent batchId returns not_found', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await commitImportWithDb(env.db, session, {
      batchId: '00000000-0000-4000-8000-000000000000',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 15. Tenant isolation
// ════════════════════════════════════════════════════════════════════════════════

describe('Tenant isolation (T-ISO)', () => {
  it('listImportBatches for org B never returns org A batches', async () => {
    const sessionA = makeSession(env.orgAId, env.userAId, 'owner');
    await previewImportWithDb(env.db, sessionA, {
      kind: 'members',
      filename: 'iso-a.csv',
      csvText: 'Full Name,Email Address\nIso A,iso-a@example.test\n',
    });

    const sessionB = makeSession(env.orgBId, env.userBId, 'owner');
    const listB = await listImportBatchesWithDb(env.db, sessionB, { kind: 'members' });
    expect(listB.every((b) => b.filename !== 'iso-a.csv')).toBe(true);
  });

  it('getImportBatch for org B returns not_found for an org A batch id', async () => {
    const sessionA = makeSession(env.orgAId, env.userAId, 'owner');
    const preview = await previewImportWithDb(env.db, sessionA, {
      kind: 'members',
      filename: 'iso-detail.csv',
      csvText: 'Full Name,Email Address\nIso Detail,iso-detail@example.test\n',
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const sessionB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await getImportBatchWithDb(env.db, sessionB, { batchId: preview.batch.id });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 16. Capabilities
// ════════════════════════════════════════════════════════════════════════════════

describe('Capabilities', () => {
  it('previewImport members: mechanic (no people:manage) → ForbiddenError', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'mechanic');
    await expect(
      previewImportWithDb(env.db, session, {
        kind: 'members',
        filename: 'cap.csv',
        csvText: MEMBERS_CSV,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('previewImport aircraft: accountant (no fleet:manage) → ForbiddenError', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      previewImportWithDb(env.db, session, {
        kind: 'aircraft',
        filename: 'cap.csv',
        csvText: AIRCRAFT_CSV,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('previewImport: null session → UnauthenticatedError', async () => {
    await expect(
      previewImportWithDb(env.db, null, { kind: 'members', filename: 'x.csv', csvText: MEMBERS_CSV }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('listImportBatches: accountant (no people:access) → ForbiddenError for members', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(listImportBatchesWithDb(env.db, session, { kind: 'members' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('commitImport: wrong-kind capability holder is refused before any write', async () => {
    // Seed a members batch as owner, then attempt commit as mechanic (has
    // fleet:manage but NOT people:manage).
    const owner = makeSession(env.orgAId, env.userAId, 'owner');
    const preview = await previewImportWithDb(env.db, owner, {
      kind: 'members',
      filename: 'cap-commit.csv',
      csvText: 'Full Name,Email Address\nCap Commit,cap-commit@example.test\n',
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const mechanic = makeSession(env.orgAId, env.userAId, 'mechanic');
    await expect(commitImportWithDb(env.db, mechanic, { batchId: preview.batch.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    // Nothing was created.
    const users = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(appUser).where(eq(appUser.email, 'cap-commit@example.test')),
    );
    expect(users).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Validation
// ════════════════════════════════════════════════════════════════════════════════

describe('Validation', () => {
  it('previewImport: invalid kind throws ValidationError', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      previewImportWithDb(env.db, session, { kind: 'bogus', filename: 'x.csv', csvText: MEMBERS_CSV }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('commitImport: non-UUID batchId throws ValidationError', async () => {
    const session = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(commitImportWithDb(env.db, session, { batchId: 'not-a-uuid' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
