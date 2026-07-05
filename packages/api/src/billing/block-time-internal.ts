/**
 * billing/block-time-internal.ts — shared internals for Slice B4 (block-time
 * / prepaid packages). NOT barrel-exported from @aeroops/api.
 *
 * All helpers here run on an ALREADY-OPEN, already org-scoped transaction
 * (the caller has already applied withSessionOrgContextWithDb) — these
 * helpers NEVER set org context themselves, mirroring billing/ledger-internal.ts's
 * convention. RLS is the enforcement backstop for every read here.
 *
 * Holds:
 *   - parseHoursNumeric — numeric(10,1) columns come back from the driver as
 *     strings; this centralizes the string→number parse so every view
 *     builder in this slice agrees on the shape.
 *   - toBlockPackageView — pure mapper from a block_package DB row to the
 *     public BlockPackageView shape, including the DISPLAY-ONLY effective
 *     rate (computeEffectiveRateCentsPerHour, @aeroops/core).
 *   - toBlockPurchaseView / loadBlockPurchasesTx — pure mapper + shared
 *     reader for a member's block_purchase history, newest first. Consumed
 *     by BOTH the staff view (get-member-block-summary.ts) and the portal
 *     self-view (portal/get-my-block-summary.ts) so they can never diverge.
 */
import { eq, and, desc } from 'drizzle-orm';
import { computeEffectiveRateCentsPerHour } from '@aeroops/core';
import { blockPurchase } from '@aeroops/db';
import type { blockPackage } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';

/** numeric(10,1) columns come back from the driver as strings. */
export function parseHoursNumeric(v: string | number): number {
  return typeof v === 'string' ? parseFloat(v) : v;
}

function parseDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

export interface BlockPackageView {
  id: string;
  orgId: string;
  name: string;
  hours: number;
  priceCents: number;
  /** DISPLAY ONLY — price_cents / hours, rounded to the nearest cent. Never stored. */
  effectiveRateCentsPerHour: number;
  active: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toBlockPackageView(row: typeof blockPackage.$inferSelect): BlockPackageView {
  const hours = parseHoursNumeric(row.hours);
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    hours,
    priceCents: row.priceCents,
    effectiveRateCentsPerHour: computeEffectiveRateCentsPerHour(row.priceCents, hours),
    active: row.active,
    createdBy: row.createdBy,
    createdAt: parseDate(row.createdAt),
    updatedAt: parseDate(row.updatedAt),
  };
}

// ─── block_purchase view + shared reader ──────────────────────────────────────

export interface BlockPurchaseView {
  id: string;
  memberUserId: string;
  packageId: string | null;
  hours: number;
  amountCents: number;
  note: string | null;
  createdBy: string;
  purchasedAt: Date;
}

export function toBlockPurchaseView(row: typeof blockPurchase.$inferSelect): BlockPurchaseView {
  return {
    id: row.id,
    memberUserId: row.userId,
    packageId: row.packageId,
    hours: parseHoursNumeric(row.hours),
    amountCents: row.amountCents,
    note: row.note,
    createdBy: row.createdBy,
    purchasedAt: parseDate(row.purchasedAt),
  };
}

/**
 * loadBlockPurchasesTx — every block_purchase row for one member, newest
 * first. RLS is the tenant-isolation backstop (org_id is still filtered
 * explicitly here as defense-in-depth, matching the house convention of
 * scoping every read even under RLS).
 */
export async function loadBlockPurchasesTx(
  tx: AnyDb,
  orgId: string,
  userId: string,
): Promise<BlockPurchaseView[]> {
  const rows = await tx
    .select()
    .from(blockPurchase)
    .where(and(eq(blockPurchase.orgId, orgId), eq(blockPurchase.userId, userId)))
    .orderBy(desc(blockPurchase.purchasedAt));
  return rows.map(toBlockPurchaseView);
}
