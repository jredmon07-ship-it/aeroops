/**
 * block-package-commands.ts — Block-time package CRUD (Slice B4).
 *
 * Operator-defined offering catalog of prepaid discounted-hour bundles (e.g.
 * "10-hour Archer block"). Money as INTEGER CENTS only (price_cents). hours
 * is a QUANTITY (flight hours), NOT money. NO Stripe, NO card data, NO real
 * money movement — this is MASTER DATA (a reusable offering), consumed by
 * sellBlockToMember (sell-block.ts) which SNAPSHOTS hours+amount_cents into a
 * block_purchase at sale time.
 *
 * COMPLIANCE: this is operator billing master data, NOT tax/GAAP/FAA
 * guidance. See docs/specs/slice-b4-block-time.md.
 *
 * GUARANTEES:
 *   - AUTHZ FIRST: billing:manage required for write ops; billing:access for reads.
 *   - org_id from session only (RLS backstop).
 *   - hours must be a positive number with at most 1 decimal place (Zod +
 *     DB CHECK + numeric(10,1) column precision).
 *   - priceCents must be a positive integer (validated by Zod + DB CHECK).
 *   - Audited: one audit row per create/update/deactivate.
 *   - NO hard delete in this slice — a package with existing purchases must
 *     never disappear from reporting; deactivateBlockPackage (active=false)
 *     is the only retirement path. (The schema's DELETE grant exists only
 *     for RLS-pattern parity with product_catalog; no command in this slice
 *     exercises it.)
 *
 * TWO CALLING FORMS per command:
 *   fn(session, input)          — app code (uses getDb()).
 *   fnWithDb(db, session, input) — tests (inject pglite).
 */

import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { blockPackage, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toBlockPackageView } from './block-time-internal.js';
import type { BlockPackageView } from './block-time-internal.js';

export type { BlockPackageView } from './block-time-internal.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── hours schema — positive, at most 1 decimal place (mirrors dispatch's meterSchema) ──

const hoursSchema = z
  .number({ message: 'hours must be a number' })
  .finite({ message: 'hours must be finite' })
  .positive({ message: 'hours must be > 0' })
  .refine((v) => Math.round(v * 10) === v * 10, {
    message: 'hours must have at most 1 decimal place',
  });

// ─── CREATE ───────────────────────────────────────────────────────────────────

const createBlockPackageInputSchema = z.object({
  name: z.string().min(1, { message: 'name must not be empty' }),
  hours: hoursSchema,
  priceCents: z
    .number()
    .int({ message: 'priceCents must be an integer' })
    .positive({ message: 'priceCents must be > 0' }),
});

export type CreateBlockPackageInput = z.infer<typeof createBlockPackageInputSchema>;

export type CreateBlockPackageResult = { ok: true; package: BlockPackageView };

async function _createBlockPackageImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CreateBlockPackageResult> {
  requireCapability(session, 'billing:manage');

  const parsed = createBlockPackageInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid createBlockPackage input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { name, hours, priceCents } = parsed.data;
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new ValidationError('[billing] invalid createBlockPackage input: name must not be empty');
  }

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const inserted = await tx
      .insert(blockPackage)
      .values({
        orgId: sess.orgId,
        name: trimmedName,
        hours: String(hours),
        priceCents,
        active: true,
        createdBy: sess.userId,
      })
      .returning();

    const row = inserted[0];
    if (!row) throw new Error('[billing] createBlockPackage: INSERT returned no rows');

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.block_package_created',
      entityType: 'block_package',
      entityId: row.id,
      metadata: { name: trimmedName, hours, priceCents },
    });

    return { ok: true, package: toBlockPackageView(row) };
  });
}

export async function createBlockPackage(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateBlockPackageResult> {
  const db = await getDb();
  return _createBlockPackageImpl(db, session, input);
}

export async function createBlockPackageWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateBlockPackageResult> {
  return _createBlockPackageImpl(db, session, input);
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

const updateBlockPackageInputSchema = z
  .object({
    id: z.string().regex(UUID_RE, { message: 'id must be a UUID' }),
    name: z.string().min(1, { message: 'name must not be empty' }).optional(),
    hours: hoursSchema.optional(),
    priceCents: z
      .number()
      .int({ message: 'priceCents must be an integer' })
      .positive({ message: 'priceCents must be > 0' })
      .optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.name !== undefined ||
      d.hours !== undefined ||
      d.priceCents !== undefined ||
      d.active !== undefined,
    { message: 'at least one field must be provided' },
  );

export type UpdateBlockPackageInput = z.infer<typeof updateBlockPackageInputSchema>;

export type UpdateBlockPackageResult =
  | { ok: true; package: BlockPackageView }
  | { ok: false; reason: 'not_found' };

async function _updateBlockPackageImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<UpdateBlockPackageResult> {
  requireCapability(session, 'billing:manage');

  const parsed = updateBlockPackageInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid updateBlockPackage input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { id, name, hours, priceCents, active } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const existing = await tx
      .select({ id: blockPackage.id })
      .from(blockPackage)
      .where(eq(blockPackage.id, id))
      .limit(1);

    if (!existing[0]) {
      return { ok: false, reason: 'not_found' } as const;
    }

    const changed: Record<string, unknown> = {};
    if (name !== undefined) changed.name = name.trim();
    if (hours !== undefined) changed.hours = String(hours);
    if (priceCents !== undefined) changed.priceCents = priceCents;
    if (active !== undefined) changed.active = active;

    const updated = await tx
      .update(blockPackage)
      .set({ ...changed, updatedAt: sql`NOW()` })
      .where(eq(blockPackage.id, id))
      .returning();

    const row = updated[0];
    if (!row) throw new Error('[billing] updateBlockPackage: UPDATE returned no rows');

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.block_package_updated',
      entityType: 'block_package',
      entityId: id,
      metadata: { id, changed: Object.keys(changed) },
    });

    return { ok: true, package: toBlockPackageView(row) };
  });
}

export async function updateBlockPackage(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UpdateBlockPackageResult> {
  const db = await getDb();
  return _updateBlockPackageImpl(db, session, input);
}

export async function updateBlockPackageWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UpdateBlockPackageResult> {
  return _updateBlockPackageImpl(db, session, input);
}

// ─── DEACTIVATE ───────────────────────────────────────────────────────────────
//
// A dedicated command (rather than routing every retirement through the
// generic update) — a distinct audit action name
// ('billing.block_package_deactivated') keeps the audit trail
// self-explanatory. Idempotent: deactivating an already-inactive package
// succeeds silently (active stays false).

const deactivateBlockPackageInputSchema = z.object({
  id: z.string().regex(UUID_RE, { message: 'id must be a UUID' }),
});

export type DeactivateBlockPackageInput = z.infer<typeof deactivateBlockPackageInputSchema>;

export type DeactivateBlockPackageResult =
  | { ok: true; package: BlockPackageView }
  | { ok: false; reason: 'not_found' };

async function _deactivateBlockPackageImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<DeactivateBlockPackageResult> {
  requireCapability(session, 'billing:manage');

  const parsed = deactivateBlockPackageInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid deactivateBlockPackage input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { id } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const existing = await tx
      .select({ id: blockPackage.id })
      .from(blockPackage)
      .where(eq(blockPackage.id, id))
      .limit(1);

    if (!existing[0]) {
      return { ok: false, reason: 'not_found' } as const;
    }

    const updated = await tx
      .update(blockPackage)
      .set({ active: false, updatedAt: sql`NOW()` })
      .where(eq(blockPackage.id, id))
      .returning();

    const row = updated[0];
    if (!row) throw new Error('[billing] deactivateBlockPackage: UPDATE returned no rows');

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.block_package_deactivated',
      entityType: 'block_package',
      entityId: id,
      metadata: { id },
    });

    return { ok: true, package: toBlockPackageView(row) };
  });
}

export async function deactivateBlockPackage(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<DeactivateBlockPackageResult> {
  const db = await getDb();
  return _deactivateBlockPackageImpl(db, session, input);
}

export async function deactivateBlockPackageWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<DeactivateBlockPackageResult> {
  return _deactivateBlockPackageImpl(db, session, input);
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

export interface ListBlockPackagesOptions {
  includeInactive?: boolean;
}

export interface ListBlockPackagesResult {
  packages: BlockPackageView[];
}

async function _listBlockPackagesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  options: ListBlockPackagesOptions = {},
): Promise<ListBlockPackagesResult> {
  requireCapability(session, 'billing:access');

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const rows = options.includeInactive
      ? await tx.select().from(blockPackage).orderBy(blockPackage.name)
      : await tx
          .select()
          .from(blockPackage)
          .where(eq(blockPackage.active, true))
          .orderBy(blockPackage.name);

    return { packages: rows.map(toBlockPackageView) };
  });
}

export async function listBlockPackages(
  session: AppSession | null | undefined,
  options: ListBlockPackagesOptions = {},
): Promise<ListBlockPackagesResult> {
  const db = await getDb();
  return _listBlockPackagesImpl(db, session, options);
}

export async function listBlockPackagesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  options: ListBlockPackagesOptions = {},
): Promise<ListBlockPackagesResult> {
  return _listBlockPackagesImpl(db, session, options);
}
