/**
 * product-catalog-commands.ts — Product catalog CRUD (Slice P2 — POS).
 *
 * Operator-defined price list of non-flight goods/services (headsets,
 * charts, fuel, merch). Money as INTEGER CENTS only. NO Stripe, NO payment,
 * NO card data, NO real money movement — this is master data (a reusable
 * price list), consumed by createCounterSale (counter-sale.ts) which
 * SNAPSHOTS name+price into an invoice_line_item at sale time.
 *
 * COMPLIANCE: sku/category are FREE-TEXT operator labels — NOT a tax class.
 * This slice computes NO tax. [VERIFY-P2-A].
 *
 * GUARANTEES:
 *   - AUTHZ FIRST: billing:manage required for write ops; billing:access for reads.
 *   - org_id from session only (RLS backstop).
 *   - unit_price_cents must be a positive integer (validated by Zod + DB CHECK).
 *   - Audited: one audit row per create/update/delete.
 *   - deleteProductCatalogItem: HARD delete is safe — invoice_line_item
 *     snapshots name+price and holds NO FK to product_catalog, so deleting a
 *     catalog item never orphans a historical sale record. Operators who want
 *     to preserve the item instead set active=false via update.
 *
 * TWO CALLING FORMS per command:
 *   fn(session, input)          — app code (uses getDb()).
 *   fnWithDb(db, session, input) — tests (inject pglite).
 */

import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { productCatalog, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── View type ─────────────────────────────────────────────────────────────────

export interface ProductCatalogView {
  id:              string;
  orgId:           string;
  name:            string;
  unitPriceCents:  number;
  sku:             string | null;
  category:        string | null;
  active:          boolean;
  createdBy:       string;
  createdAt:       Date;
  updatedAt:       Date;
}

function parseDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

function toProductCatalogView(row: typeof productCatalog.$inferSelect): ProductCatalogView {
  return {
    id:             row.id,
    orgId:          row.orgId,
    name:           row.name,
    unitPriceCents: row.unitPriceCents,
    sku:            row.sku ?? null,
    category:       row.category ?? null,
    active:         row.active,
    createdBy:      row.createdBy,
    createdAt:      parseDate(row.createdAt),
    updatedAt:      parseDate(row.updatedAt),
  };
}

// Normalize an optional free-text field: trim; empty string → null; undefined stays undefined.
function normalizeOptionalText(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

const createProductCatalogItemInputSchema = z.object({
  name:           z.string().min(1, { message: 'name must not be empty' }),
  unitPriceCents: z
    .number()
    .int({ message: 'unitPriceCents must be an integer' })
    .positive({ message: 'unitPriceCents must be > 0' }),
  sku:      z.string().optional(),
  category: z.string().optional(),
});

export type CreateProductCatalogItemInput = z.infer<typeof createProductCatalogItemInputSchema>;

export type CreateProductCatalogItemResult = { ok: true; item: ProductCatalogView };

async function _createProductCatalogItemImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CreateProductCatalogItemResult> {
  requireCapability(session, 'billing:manage');

  const parsed = createProductCatalogItemInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid createProductCatalogItem input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { name, unitPriceCents, sku, category } = parsed.data;
  const normalizedSku = normalizeOptionalText(sku) ?? null;
  const normalizedCategory = normalizeOptionalText(category) ?? null;
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new ValidationError('[billing] invalid createProductCatalogItem input: name must not be empty');
  }

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const inserted = await tx
      .insert(productCatalog)
      .values({
        orgId:          sess.orgId,
        name:           trimmedName,
        unitPriceCents,
        sku:            normalizedSku,
        category:       normalizedCategory,
        active:         true,
        createdBy:      sess.userId,
      })
      .returning();

    const row = inserted[0];
    if (!row) throw new Error('[billing] createProductCatalogItem: INSERT returned no rows');

    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'billing.product_catalog_item_created',
      entityType:  'product_catalog',
      entityId:    row.id,
      metadata: {
        name: trimmedName,
        unitPriceCents,
        sku: normalizedSku,
        category: normalizedCategory,
      },
    });

    return { ok: true, item: toProductCatalogView(row) };
  });
}

export async function createProductCatalogItem(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateProductCatalogItemResult> {
  const db = await getDb();
  return _createProductCatalogItemImpl(db, session, input);
}

export async function createProductCatalogItemWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateProductCatalogItemResult> {
  return _createProductCatalogItemImpl(db, session, input);
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

const updateProductCatalogItemInputSchema = z
  .object({
    id:             z.string().regex(UUID_RE, { message: 'id must be a UUID' }),
    name:           z.string().min(1, { message: 'name must not be empty' }).optional(),
    unitPriceCents: z
      .number()
      .int({ message: 'unitPriceCents must be an integer' })
      .positive({ message: 'unitPriceCents must be > 0' })
      .optional(),
    sku:      z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    active:   z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.name !== undefined ||
      d.unitPriceCents !== undefined ||
      d.sku !== undefined ||
      d.category !== undefined ||
      d.active !== undefined,
    { message: 'at least one field must be provided' },
  );

export type UpdateProductCatalogItemInput = z.infer<typeof updateProductCatalogItemInputSchema>;

export type UpdateProductCatalogItemResult =
  | { ok: true; item: ProductCatalogView }
  | { ok: false; reason: 'not_found' };

async function _updateProductCatalogItemImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<UpdateProductCatalogItemResult> {
  requireCapability(session, 'billing:manage');

  const parsed = updateProductCatalogItemInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid updateProductCatalogItem input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { id, name, unitPriceCents, sku, category, active } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const existing = await tx
      .select({ id: productCatalog.id })
      .from(productCatalog)
      .where(eq(productCatalog.id, id))
      .limit(1);

    if (!existing[0]) {
      return { ok: false, reason: 'not_found' } as const;
    }

    const changed: Record<string, unknown> = {};
    if (name !== undefined) changed.name = name.trim();
    if (unitPriceCents !== undefined) changed.unitPriceCents = unitPriceCents;
    if (sku !== undefined) changed.sku = normalizeOptionalText(sku ?? undefined) ?? null;
    if (category !== undefined) changed.category = normalizeOptionalText(category ?? undefined) ?? null;
    if (active !== undefined) changed.active = active;

    const updated = await tx
      .update(productCatalog)
      .set({ ...changed, updatedAt: sql`NOW()` })
      .where(eq(productCatalog.id, id))
      .returning();

    const row = updated[0];
    if (!row) throw new Error('[billing] updateProductCatalogItem: UPDATE returned no rows');

    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'billing.product_catalog_item_updated',
      entityType:  'product_catalog',
      entityId:    id,
      metadata:    { id, changed: Object.keys(changed) },
    });

    return { ok: true, item: toProductCatalogView(row) };
  });
}

export async function updateProductCatalogItem(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UpdateProductCatalogItemResult> {
  const db = await getDb();
  return _updateProductCatalogItemImpl(db, session, input);
}

export async function updateProductCatalogItemWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UpdateProductCatalogItemResult> {
  return _updateProductCatalogItemImpl(db, session, input);
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

export interface ListProductCatalogItemsOptions {
  includeInactive?: boolean;
}

export interface ListProductCatalogItemsResult {
  items: ProductCatalogView[];
}

async function _listProductCatalogItemsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  options: ListProductCatalogItemsOptions = {},
): Promise<ListProductCatalogItemsResult> {
  requireCapability(session, 'billing:access');

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const rows = options.includeInactive
      ? await tx.select().from(productCatalog).orderBy(productCatalog.name)
      : await tx
          .select()
          .from(productCatalog)
          .where(eq(productCatalog.active, true))
          .orderBy(productCatalog.name);

    return { items: rows.map(toProductCatalogView) };
  });
}

export async function listProductCatalogItems(
  session: AppSession | null | undefined,
  options: ListProductCatalogItemsOptions = {},
): Promise<ListProductCatalogItemsResult> {
  const db = await getDb();
  return _listProductCatalogItemsImpl(db, session, options);
}

export async function listProductCatalogItemsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  options: ListProductCatalogItemsOptions = {},
): Promise<ListProductCatalogItemsResult> {
  return _listProductCatalogItemsImpl(db, session, options);
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

const deleteProductCatalogItemInputSchema = z.object({
  id: z.string().regex(UUID_RE, { message: 'id must be a UUID' }),
});

export type DeleteProductCatalogItemInput = z.infer<typeof deleteProductCatalogItemInputSchema>;

export type DeleteProductCatalogItemResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' };

async function _deleteProductCatalogItemImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<DeleteProductCatalogItemResult> {
  requireCapability(session, 'billing:manage');

  const parsed = deleteProductCatalogItemInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid deleteProductCatalogItem input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { id } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const existing = await tx
      .select({ id: productCatalog.id, name: productCatalog.name })
      .from(productCatalog)
      .where(eq(productCatalog.id, id))
      .limit(1);

    if (!existing[0]) {
      return { ok: false, reason: 'not_found' } as const;
    }

    // Hard delete is safe — invoice_line_item snapshots name+price and holds
    // NO FK to product_catalog (see migration 0031 header guarantee 4).
    await tx.delete(productCatalog).where(eq(productCatalog.id, id));

    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'billing.product_catalog_item_deleted',
      entityType:  'product_catalog',
      entityId:    id,
      metadata:    { id, name: existing[0].name },
    });

    return { ok: true };
  });
}

export async function deleteProductCatalogItem(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<DeleteProductCatalogItemResult> {
  const db = await getDb();
  return _deleteProductCatalogItemImpl(db, session, input);
}

export async function deleteProductCatalogItemWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<DeleteProductCatalogItemResult> {
  return _deleteProductCatalogItemImpl(db, session, input);
}
