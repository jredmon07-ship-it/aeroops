/**
 * block-time.test.ts — Integration tests for Slice B4: Block-time / prepaid
 * packages.
 *
 * Applies migrations 0000–0034 (0034 = block_package / block_purchase +
 * the additive ledger_entry.entry_type widening).
 * Uses PGlite + WithDb functions. Two-org seed (seedTwoOrgs, called ONCE —
 * org.slug is UNIQUE) + a seedMember helper (mirrors billing-ledger.test.ts)
 * for fresh, isolated members within an existing org when a test needs a
 * clean ledger.
 *
 * COVERAGE:
 *   PACKAGE CRUD: create/update/deactivate/list + caps + audit + T-ISO
 *   SELL BLOCK: atomic block_purchase + ONE 'block_purchase' ledger credit;
 *     package sale vs ad-hoc sale; member/package refusals; caps; T-ISO
 *     (no enumeration)
 *   SUMMARIES: getMemberBlockSummary (staff) / getMyBlockSummary (portal,
 *     self-scoped) — purchase totals + prepaidBalanceCents clamp + history
 *   APPEND-ONLY: raw UPDATE/DELETE on block_purchase denied under aeroops_app
 *   REGRESSION: entry_type CHECK still rejects unknown values; many sales
 *     total exactly Σ(amountCents) (integer-cents property, smoke)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  auditLog,
  blockPurchase,
  ledgerEntry,
  appUser,
  membership,
  loadMigrationSql,
} from '@aeroops/db';
import { eq, and, sql } from 'drizzle-orm';
import type { PgliteTestClient } from '@aeroops/db';

import {
  createBlockPackageWithDb,
  updateBlockPackageWithDb,
  deactivateBlockPackageWithDb,
  listBlockPackagesWithDb,
} from '../billing/block-package-commands.js';
import { sellBlockToMemberWithDb } from '../billing/sell-block.js';
import { getMemberBlockSummaryWithDb } from '../billing/get-member-block-summary.js';
import { getMyBlockSummaryWithDb } from '../portal/get-my-block-summary.js';
import { createRateScheduleWithDb } from '../billing/rate-commands.js';
import { generateInvoiceFromDispatchWithDb } from '../billing/generate-invoice.js';
import { finalizeInvoiceWithDb } from '../billing/invoice-status-commands.js';
import { createResourceWithDb } from '../scheduling/resource-commands.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { openDispatchWithDb } from '../dispatch/open-dispatch.js';
import { closeDispatchWithDb } from '../dispatch/close-dispatch.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// All up migrations through 0038 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0042');

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
function nextTag(prefix: string): string {
  tailSuffix += 1;
  return `${prefix}${tailSuffix}`;
}

/** Insert a fresh app_user + membership in the given org. Returns userId. Mirrors billing-ledger.test.ts's seedMember. */
async function seedMember(db: PgliteTestClient, orgId: string, tag: string): Promise<string> {
  const uniqueTag = nextTag(tag);
  const rows = await withOrgContext(db, orgId, (tx) =>
    tx
      .insert(appUser)
      .values({ orgId, email: `${uniqueTag.toLowerCase()}@example.test`, fullName: `Member ${uniqueTag}` })
      .returning({ id: appUser.id }),
  );
  const row = rows[0];
  if (!row) throw new Error('seedMember: INSERT returned no row');
  await withOrgContext(db, orgId, (tx) =>
    tx.insert(membership).values({ orgId, userId: row.id, role: 'renter' }),
  );
  return row.id;
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

/** Creates an active block package in orgId, returns the created package. */
async function seedPackage(
  db: PgliteTestClient,
  orgId: string,
  userId: string,
  name = '10-hour Archer block',
  hours = 10,
  priceCents = 150000,
) {
  const sess = makeSession(orgId, userId, 'owner');
  const r = await createBlockPackageWithDb(db, sess, { name, hours, priceCents });
  return r.package;
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1 — block_package CRUD
// ════════════════════════════════════════════════════════════════════════════════

describe('BLOCK PACKAGE: createBlockPackage', () => {
  it('owner creates a package — integer cents + effective rate + ONE audit row', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await createBlockPackageWithDb(env.db, sess, {
      name: '10-hour Archer block',
      hours: 10,
      priceCents: 150000,
    });
    expect(result.ok).toBe(true);
    expect(result.package.name).toBe('10-hour Archer block');
    expect(result.package.hours).toBe(10);
    expect(result.package.priceCents).toBe(150000);
    expect(Number.isInteger(result.package.priceCents)).toBe(true);
    expect(result.package.effectiveRateCentsPerHour).toBe(15000);
    expect(result.package.active).toBe(true);

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog).where(
        and(
          eq(auditLog.action, 'billing.block_package_created'),
          eq(auditLog.entityId, result.package.id),
        ),
      ),
    );
    expect(rows.length).toBe(1);
  });

  it('hours with 2 decimal places ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      createBlockPackageWithDb(env.db, sess, { name: 'Bad Hours', hours: 10.55, priceCents: 1000 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('non-integer priceCents ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      createBlockPackageWithDb(env.db, sess, { name: 'Bad Price', hours: 10, priceCents: 100.5 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('zero/negative hours ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      createBlockPackageWithDb(env.db, sess, { name: 'Zero Hours', hours: 0, priceCents: 1000 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createBlockPackageWithDb(env.db, sess, { name: 'Neg Hours', hours: -5, priceCents: 1000 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('zero/negative priceCents ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      createBlockPackageWithDb(env.db, sess, { name: 'Free', hours: 10, priceCents: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('empty name ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      createBlockPackageWithDb(env.db, sess, { name: '', hours: 10, priceCents: 1000 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('null session ⇒ UnauthenticatedError', async () => {
    await expect(
      createBlockPackageWithDb(env.db, null, { name: 'X', hours: 10, priceCents: 1000 }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('dispatcher (no billing:manage) ⇒ ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(
      createBlockPackageWithDb(env.db, sess, { name: 'X', hours: 10, priceCents: 1000 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('accountant (billing:access only, no billing:manage) ⇒ ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      createBlockPackageWithDb(env.db, sess, { name: 'X', hours: 10, priceCents: 1000 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('cfi ⇒ ForbiddenError (no billing:access/billing:manage at all)', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'cfi');
    await expect(
      createBlockPackageWithDb(env.db, sess, { name: 'X', hours: 10, priceCents: 1000 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('BLOCK PACKAGE: updateBlockPackage', () => {
  it('updates name/hours/price/active + ONE audit row', async () => {
    const pkg = await seedPackage(env.db, env.orgAId, env.userAId, 'Old Name', 5, 50000);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await updateBlockPackageWithDb(env.db, sess, {
      id: pkg.id,
      name: 'New Name',
      hours: 8,
      priceCents: 96000,
      active: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.package.name).toBe('New Name');
    expect(result.package.hours).toBe(8);
    expect(result.package.priceCents).toBe(96000);
    expect(result.package.effectiveRateCentsPerHour).toBe(12000);
    expect(result.package.active).toBe(false);

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog).where(
        and(
          eq(auditLog.action, 'billing.block_package_updated'),
          eq(auditLog.entityId, pkg.id),
        ),
      ),
    );
    expect(rows.length).toBe(1);
  });

  it('unknown id ⇒ not_found', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await updateBlockPackageWithDb(env.db, sess, {
      id: '00000000-0000-0000-0000-000000000099',
      name: 'X',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('accountant cannot update ⇒ ForbiddenError', async () => {
    const pkg = await seedPackage(env.db, env.orgAId, env.userAId, 'Accountant Test', 5, 50000);
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      updateBlockPackageWithDb(env.db, sess, { id: pkg.id, name: 'Nope' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('BLOCK PACKAGE: deactivateBlockPackage', () => {
  it('sets active=false + a DISTINCT audit action + is idempotent', async () => {
    const pkg = await seedPackage(env.db, env.orgAId, env.userAId, 'To Deactivate', 5, 50000);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await deactivateBlockPackageWithDb(env.db, sess, { id: pkg.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.package.active).toBe(false);

    // Idempotent — deactivating again succeeds and stays false.
    const second = await deactivateBlockPackageWithDb(env.db, sess, { id: pkg.id });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.package.active).toBe(false);

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog).where(
        and(
          eq(auditLog.action, 'billing.block_package_deactivated'),
          eq(auditLog.entityId, pkg.id),
        ),
      ),
    );
    expect(rows.length).toBe(2); // once per call
  });

  it('unknown id ⇒ not_found', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await deactivateBlockPackageWithDb(env.db, sess, {
      id: '00000000-0000-0000-0000-000000000098',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('accountant cannot deactivate ⇒ ForbiddenError', async () => {
    const pkg = await seedPackage(env.db, env.orgAId, env.userAId, 'Protected', 5, 50000);
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      deactivateBlockPackageWithDb(env.db, sess, { id: pkg.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('BLOCK PACKAGE: listBlockPackages', () => {
  it('default excludes inactive; includeInactive includes them; ordered by name', async () => {
    const activePkg = await seedPackage(env.db, env.orgAId, env.userAId, 'Zebra Block', 5, 50000);
    const inactivePkg = await seedPackage(env.db, env.orgAId, env.userAId, 'Alpha Block', 5, 50000);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await deactivateBlockPackageWithDb(env.db, sess, { id: inactivePkg.id });

    const activeOnly = await listBlockPackagesWithDb(env.db, sess, {});
    const activeNames = activeOnly.packages.map((p) => p.name);
    expect(activeNames).toContain('Zebra Block');
    expect(activeNames).not.toContain('Alpha Block');

    const withInactive = await listBlockPackagesWithDb(env.db, sess, { includeInactive: true });
    const allNames = withInactive.packages.map((p) => p.name);
    expect(allNames).toContain('Zebra Block');
    expect(allNames).toContain('Alpha Block');

    const alphaIdx = allNames.indexOf('Alpha Block');
    const zebraIdx = allNames.indexOf('Zebra Block');
    expect(alphaIdx).toBeLessThan(zebraIdx);
    void activePkg;
  });

  it('accountant (billing:access) CAN list', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    const result = await listBlockPackagesWithDb(env.db, sess, {});
    expect(Array.isArray(result.packages)).toBe(true);
  });

  it('null session ⇒ UnauthenticatedError', async () => {
    await expect(listBlockPackagesWithDb(env.db, null, {})).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2 — TENANT ISOLATION (block_package)
// ════════════════════════════════════════════════════════════════════════════════

describe('T-ISO: block_package', () => {
  it('org B cannot list org A packages', async () => {
    await seedPackage(env.db, env.orgAId, env.userAId, 'Org A Only Block', 5, 50000);
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await listBlockPackagesWithDb(env.db, sessB, { includeInactive: true });
    expect(result.packages.map((p) => p.name)).not.toContain('Org A Only Block');
  });

  it('org B cannot update org A package ⇒ not_found', async () => {
    const pkgA = await seedPackage(env.db, env.orgAId, env.userAId, 'A Update Target', 5, 50000);
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await updateBlockPackageWithDb(env.db, sessB, { id: pkgA.id, name: 'Hijacked' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('org B cannot deactivate org A package ⇒ not_found', async () => {
    const pkgA = await seedPackage(env.db, env.orgAId, env.userAId, 'A Deactivate Target', 5, 50000);
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await deactivateBlockPackageWithDb(env.db, sessB, { id: pkgA.id });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 3 — sellBlockToMember
// ════════════════════════════════════════════════════════════════════════════════

describe('sellBlockToMember: package sale', () => {
  it('posts ONE block_purchase + ONE block_purchase credit ledger_entry that RAISES the balance by exactly amountCents', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'PkgSaleMember');
    const pkg = await seedPackage(env.db, env.orgAId, env.userAId, 'Sale Package', 10, 150000);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');

    const result = await sellBlockToMemberWithDb(env.db, sess, {
      memberId,
      packageId: pkg.id,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.purchase.hours).toBe(10);
    expect(result.purchase.amountCents).toBe(150000);
    expect(result.purchase.packageId).toBe(pkg.id);
    expect(result.entry.entryType).toBe('block_purchase');
    expect(result.entry.direction).toBe('credit');
    expect(result.entry.amountCents).toBe(150000);
    expect(result.balanceCentsAfter).toBe(150000);

    const purchaseRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(blockPurchase).where(eq(blockPurchase.id, result.purchase.id)),
    );
    expect(purchaseRows.length).toBe(1);

    const ledgerRows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(ledgerEntry).where(
        and(eq(ledgerEntry.entryType, 'block_purchase'), eq(ledgerEntry.amountCents, 150000)),
      ),
    );
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0]?.direction).toBe('credit');

    const rows = await withOrgContext(env.db, env.orgAId, (tx) =>
      tx.select().from(auditLog).where(
        and(eq(auditLog.action, 'billing.block_sold'), eq(auditLog.entityId, result.purchase.id)),
      ),
    );
    expect(rows.length).toBe(1);
  });

  it('inactive package ⇒ package_inactive', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'InactivePkgMember');
    const pkg = await seedPackage(env.db, env.orgAId, env.userAId, 'Retired Block', 5, 50000);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await deactivateBlockPackageWithDb(env.db, sess, { id: pkg.id });
    const result = await sellBlockToMemberWithDb(env.db, sess, { memberId, packageId: pkg.id });
    expect(result).toEqual({ ok: false, reason: 'package_inactive' });
  });

  it('unknown package ⇒ package_not_found', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'UnknownPkgMember');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await sellBlockToMemberWithDb(env.db, sess, {
      memberId,
      packageId: '00000000-0000-0000-0000-000000000077',
    });
    expect(result).toEqual({ ok: false, reason: 'package_not_found' });
  });
});

describe('sellBlockToMember: ad-hoc sale', () => {
  it('uses the provided hours+amountCents as-is (no package)', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'AdhocMember');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await sellBlockToMemberWithDb(env.db, sess, {
      memberId,
      hours: 3.5,
      amountCents: 42000,
      note: 'Paid cash at the counter',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.purchase.hours).toBe(3.5);
    expect(result.purchase.amountCents).toBe(42000);
    expect(result.purchase.packageId).toBeNull();
    expect(result.purchase.note).toBe('Paid cash at the counter');
    expect(result.entry.memo).toBe('Paid cash at the counter');
  });

  it('unknown member ⇒ member_not_found', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await sellBlockToMemberWithDb(env.db, sess, {
      memberId: '00000000-0000-0000-0000-000000000078',
      hours: 1,
      amountCents: 100,
    });
    expect(result).toEqual({ ok: false, reason: 'member_not_found' });
  });

  it('both packageId AND hours/amountCents ⇒ ValidationError', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'BothGivenMember');
    const pkg = await seedPackage(env.db, env.orgAId, env.userAId, 'Both Given', 5, 50000);
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      sellBlockToMemberWithDb(env.db, sess, {
        memberId,
        packageId: pkg.id,
        hours: 1,
        amountCents: 100,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('neither packageId nor hours/amountCents ⇒ ValidationError', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'NeitherMember');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      sellBlockToMemberWithDb(env.db, sess, { memberId }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('only hours given (missing amountCents) ⇒ ValidationError', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'OnlyHoursMember');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      sellBlockToMemberWithDb(env.db, sess, { memberId, hours: 5 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('hours with 2 decimal places ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      sellBlockToMemberWithDb(env.db, sess, { memberId: env.userAId, hours: 1.23, amountCents: 100 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('non-integer amountCents ⇒ ValidationError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    await expect(
      sellBlockToMemberWithDb(env.db, sess, { memberId: env.userAId, hours: 1, amountCents: 100.5 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('caps: null session ⇒ Unauthenticated', async () => {
    await expect(
      sellBlockToMemberWithDb(env.db, null, { memberId: env.userAId, hours: 1, amountCents: 100 }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('caps: accountant (billing:access only) ⇒ ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(
      sellBlockToMemberWithDb(env.db, sess, { memberId: env.userAId, hours: 1, amountCents: 100 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('caps: cfi ⇒ ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'cfi');
    await expect(
      sellBlockToMemberWithDb(env.db, sess, { memberId: env.userAId, hours: 1, amountCents: 100 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('caps: dispatcher ⇒ ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'dispatcher');
    await expect(
      sellBlockToMemberWithDb(env.db, sess, { memberId: env.userAId, hours: 1, amountCents: 100 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('T-ISO: sellBlockToMember — cross-org ids never leak (no enumeration)', () => {
  it('org B session with org A memberId ⇒ member_not_found (not a Forbidden/leak)', async () => {
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await sellBlockToMemberWithDb(env.db, sessB, {
      memberId: env.userAId, // belongs to org A
      hours: 1,
      amountCents: 100,
    });
    expect(result).toEqual({ ok: false, reason: 'member_not_found' });
  });

  it('org B session with org A packageId ⇒ package_not_found', async () => {
    const pkgA = await seedPackage(env.db, env.orgAId, env.userAId, 'A Only Block', 5, 50000);
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await sellBlockToMemberWithDb(env.db, sessB, {
      memberId: env.userBId,
      packageId: pkgA.id,
    });
    expect(result).toEqual({ ok: false, reason: 'package_not_found' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 4 — getMemberBlockSummary (staff view)
// ════════════════════════════════════════════════════════════════════════════════

describe('getMemberBlockSummary', () => {
  it('totals + history match multiple sales exactly (newest-first)', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'SummaryMember');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const r1 = await sellBlockToMemberWithDb(env.db, sess, {
      memberId,
      hours: 10,
      amountCents: 100000,
      note: 'Summary test sale 1',
    });
    const r2 = await sellBlockToMemberWithDb(env.db, sess, {
      memberId,
      hours: 5,
      amountCents: 50000,
      note: 'Summary test sale 2',
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const result = await getMemberBlockSummaryWithDb(env.db, sess, { memberId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.memberUserId).toBe(memberId);
    expect(result.summary.totalHoursPurchased).toBe(15);
    expect(result.summary.totalAmountPurchasedCents).toBe(150000);
    expect(result.summary.prepaidBalanceCents).toBe(150000);
    expect(result.summary.purchases.length).toBe(2);
    // newest-first: sale 2 before sale 1.
    const notes = result.summary.purchases.map((p) => p.note);
    expect(notes.indexOf('Summary test sale 2')).toBeLessThan(notes.indexOf('Summary test sale 1'));
  });

  it('member with no blocks returns clean-empty', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'EmptyMember');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await getMemberBlockSummaryWithDb(env.db, sess, { memberId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.totalHoursPurchased).toBe(0);
    expect(result.summary.totalAmountPurchasedCents).toBe(0);
    expect(result.summary.prepaidBalanceCents).toBe(0);
    expect(result.summary.purchases).toEqual([]);
  });

  it('prepaidBalanceCents clamps to 0 when the member owes money (never negative)', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'OwesMoneyMember');
    const ownerSess = makeSession(env.orgAId, env.userAId, 'owner');

    // Give the member a small block credit ($100), then invoice them for MORE
    // than that credit ($200) so the derived ledger balance goes negative.
    await sellBlockToMemberWithDb(env.db, ownerSess, {
      memberId,
      hours: 1,
      amountCents: 10000,
    });

    const tag = nextTag('OwesTail');
    const resource = await createResourceWithDb(env.db, ownerSess, {
      kind: 'aircraft',
      displayName: `Test ${tag}`,
      tailNumber: `N${tag}`,
    });
    const start = new Date(`2026-09-0${(tailSuffix % 9) + 1}T08:00:00Z`);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    const rResult = await createReservationWithDb(env.db, ownerSess, {
      startAt: start,
      endAt: end,
      resourceIds: [resource.id],
    });
    if (!rResult.ok) throw new Error(`reservation setup failed: ${rResult.reason}`);

    const openR = await openDispatchWithDb(env.db, ownerSess, {
      reservationId: rResult.reservation.id,
      resourceId: resource.id,
      pilotUserId: memberId,
      hobbsOut: 100.0,
      tachOut: 50.0,
    });
    if (!openR.ok) throw new Error(`openDispatch failed: ${openR.reason}`);
    const closeR = await closeDispatchWithDb(env.db, ownerSess, {
      ticketId: openR.ticket.id,
      hobbsIn: 102.0,
      tachIn: 52.0,
    });
    if (!closeR.ok) throw new Error(`closeDispatch failed: ${closeR.reason}`);

    const rateR = await createRateScheduleWithDb(env.db, ownerSess, {
      name: `${tag} rate`,
      rateKind: 'wet_hourly',
      amountCents: 100000, // $1000/hr → 2 hrs flown = $2000 debit
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    if (!rateR.ok) throw new Error('rate setup failed');

    const invR = await generateInvoiceFromDispatchWithDb(env.db, ownerSess, {
      dispatchTicketId: openR.ticket.id,
      rateScheduleId: rateR.rate.id,
      memberUserId: memberId,
    });
    if (!invR.ok) throw new Error('invoice generation failed');
    const finR = await finalizeInvoiceWithDb(env.db, ownerSess, { id: invR.invoice.id });
    if (!finR.ok) throw new Error('invoice finalize failed');

    const result = await getMemberBlockSummaryWithDb(env.db, ownerSess, { memberId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // $100 credit - $2000 debit ⇒ owes money ⇒ clamped to 0, never negative.
    expect(result.summary.prepaidBalanceCents).toBe(0);
    expect(result.summary.totalAmountPurchasedCents).toBe(10000);
  });

  it('unknown/cross-org member ⇒ not_found', async () => {
    const sessB = makeSession(env.orgBId, env.userBId, 'owner');
    const result = await getMemberBlockSummaryWithDb(env.db, sessB, { memberId: env.userAId });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('caps: null session ⇒ Unauthenticated', async () => {
    await expect(getMemberBlockSummaryWithDb(env.db, null, { memberId: env.userAId })).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('caps: cfi (no billing:access) ⇒ ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'cfi');
    await expect(
      getMemberBlockSummaryWithDb(env.db, sess, { memberId: env.userAId }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('caps: accountant (billing:access) CAN read', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    const result = await getMemberBlockSummaryWithDb(env.db, sess, { memberId: env.userAId });
    expect(result.ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 5 — getMyBlockSummary (portal self-view)
// ════════════════════════════════════════════════════════════════════════════════

describe('getMyBlockSummary (portal, self-scoped)', () => {
  it('matches getMemberBlockSummary for the same member (no divergence between the two views)', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'PortalMatchMember');
    const ownerSess = makeSession(env.orgAId, env.userAId, 'owner');
    await sellBlockToMemberWithDb(env.db, ownerSess, {
      memberId,
      hours: 4,
      amountCents: 40000,
    });

    const staffView = await getMemberBlockSummaryWithDb(env.db, ownerSess, { memberId });
    expect(staffView.ok).toBe(true);
    if (!staffView.ok) return;

    const selfSess = makeSession(env.orgAId, memberId, 'renter');
    const myView = await getMyBlockSummaryWithDb(env.db, selfSess);

    expect(myView.totalHoursPurchased).toBe(staffView.summary.totalHoursPurchased);
    expect(myView.totalAmountPurchasedCents).toBe(staffView.summary.totalAmountPurchasedCents);
    expect(myView.prepaidBalanceCents).toBe(staffView.summary.prepaidBalanceCents);
    expect(myView.purchases.length).toBe(staffView.summary.purchases.length);
  });

  it('a member with no blocks gets a clean-empty self-view', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'PortalEmptyMember');
    const selfSess = makeSession(env.orgAId, memberId, 'student');
    const result = await getMyBlockSummaryWithDb(env.db, selfSess);
    expect(result.totalHoursPurchased).toBe(0);
    expect(result.totalAmountPurchasedCents).toBe(0);
    expect(result.prepaidBalanceCents).toBe(0);
    expect(result.purchases).toEqual([]);
  });

  it('caps: null session ⇒ Unauthenticated', async () => {
    await expect(getMyBlockSummaryWithDb(env.db, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('caps: accountant (no portal:access) ⇒ ForbiddenError', async () => {
    const sess = makeSession(env.orgAId, env.userAId, 'accountant');
    await expect(getMyBlockSummaryWithDb(env.db, sess)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 6 — APPEND-ONLY (block_purchase)
// ════════════════════════════════════════════════════════════════════════════════

describe('APPEND-ONLY: block_purchase', () => {
  it('UPDATE block_purchase is denied under aeroops_app (FORCE RLS + no policy + REVOKE)', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'UpdateProbeMember');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await sellBlockToMemberWithDb(env.db, sess, {
      memberId,
      hours: 1,
      amountCents: 12345,
      note: 'append-only UPDATE probe',
    });
    if (!result.ok) throw new Error('setup failed');
    const purchaseId = result.purchase.id;

    await expect(
      env.pglite.query(`UPDATE block_purchase SET amount_cents = 1 WHERE id = '${purchaseId}' RETURNING id`),
    ).rejects.toThrow();

    const rows = await withOrgContext(env.db, env.orgAId, async (tx) => {
      const r = await tx.execute(sql`SELECT amount_cents AS "amountCents" FROM block_purchase WHERE id = ${purchaseId}::uuid`);
      return (r.rows ?? r) as Array<{ amountCents: number }>;
    });
    expect(Number(rows[0]!.amountCents)).toBe(12345);
  });

  it('DELETE block_purchase is denied under aeroops_app (FORCE RLS + no policy + REVOKE)', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'DeleteProbeMember');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await sellBlockToMemberWithDb(env.db, sess, {
      memberId,
      hours: 1,
      amountCents: 54321,
      note: 'append-only DELETE probe',
    });
    if (!result.ok) throw new Error('setup failed');
    const purchaseId = result.purchase.id;

    await expect(
      env.pglite.query(`DELETE FROM block_purchase WHERE id = '${purchaseId}' RETURNING id`),
    ).rejects.toThrow();

    const rows = await withOrgContext(env.db, env.orgAId, async (tx) => {
      const r = await tx.execute(sql`SELECT id FROM block_purchase WHERE id = ${purchaseId}::uuid`);
      return (r.rows ?? r) as Array<{ id: string }>;
    });
    expect(rows.length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 7 — REGRESSION GUARDS
// ════════════════════════════════════════════════════════════════════════════════

describe('REGRESSION: ledger_entry.entry_type CHECK still rejects unknown values', () => {
  it('a raw INSERT with an invalid entry_type is rejected', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'BogusTypeMember');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');
    const result = await sellBlockToMemberWithDb(env.db, sess, {
      memberId,
      hours: 1,
      amountCents: 100,
    });
    if (!result.ok) throw new Error('setup failed');

    await expect(
      withOrgContext(env.db, env.orgAId, async (tx) => {
        await tx.execute(sql`
          INSERT INTO ledger_entry (org_id, account_id, entry_type, direction, amount_cents)
          SELECT org_id, account_id, 'bogus_type', 'credit', 100 FROM ledger_entry LIMIT 1
        `);
      }),
    ).rejects.toThrow();
  });
});

describe('REGRESSION: no float drift across many sales (integer-cents property, smoke)', () => {
  it('N ad-hoc sales total exactly Σ(amountCents) via getMemberBlockSummary', async () => {
    const memberId = await seedMember(env.db, env.orgAId, 'ManySalesMember');
    const sess = makeSession(env.orgAId, env.userAId, 'owner');

    let expectedTotalCents = 0;
    let expectedTotalTenths = 0;
    for (let i = 0; i < 15; i += 1) {
      const amountCents = 1000 + i * 137;
      const hours = 1 + (i % 5) * 0.5;
      const r = await sellBlockToMemberWithDb(env.db, sess, {
        memberId,
        hours,
        amountCents,
      });
      expect(r.ok).toBe(true);
      expectedTotalCents += amountCents;
      expectedTotalTenths += Math.round(hours * 10);
    }

    const result = await getMemberBlockSummaryWithDb(env.db, sess, { memberId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.totalAmountPurchasedCents).toBe(expectedTotalCents);
    expect(result.summary.totalHoursPurchased).toBe(expectedTotalTenths / 10);
  });
});
