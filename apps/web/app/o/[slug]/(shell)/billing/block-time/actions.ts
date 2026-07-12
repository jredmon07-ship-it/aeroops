/**
 * billing/block-time/actions.ts — Server actions for Block-time / prepaid
 * packages (Slice B4).
 *
 * Pattern mirrors billing/pos/actions.ts exactly:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability inside the fn).
 *   3. Map ForbiddenError/UnauthenticatedError → tagged error result.
 *   4. Map ValidationError → { error: 'validation', message }.
 *   5. Pass through ok:false arms as-is (operational refusals are values).
 *
 * Dates are serialized to ISO strings at the action boundary.
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 *
 * MONEY BOUNDARY: all amounts are INTEGER CENTS. sellBlockToMemberAction only
 * ever posts an operator-recorded ledger credit (like recordManualPayment) —
 * NO Stripe, NO card/bank data, NO money moved.
 */
'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import {
  createBlockPackage,
  updateBlockPackage,
  deactivateBlockPackage,
  listBlockPackages,
  sellBlockToMember,
  getMemberBlockSummary,
  listMembers,
} from '@aeroops/api';
import type {
  BlockPackageView,
  ListBlockPackagesOptions,
  BlockPurchaseView,
  MemberBlockSummary,
  OrgMemberListRow,
} from '@aeroops/api';

// ─── Error shapes ──────────────────────────────────────────────────────────────

import { mapAuthError, isValidationError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ValidationErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ValidationErrorResult, ServerErrorResult };

// ─── Serialized types ──────────────────────────────────────────────────────────

export interface SerializedBlockPackage {
  id: string;
  name: string;
  hours: number;
  priceCents: number;
  effectiveRateCentsPerHour: number;
  active: boolean;
  createdAt: string;
}

function serializeBlockPackage(pkg: BlockPackageView): SerializedBlockPackage {
  return {
    id: pkg.id,
    name: pkg.name,
    hours: pkg.hours,
    priceCents: pkg.priceCents,
    effectiveRateCentsPerHour: pkg.effectiveRateCentsPerHour,
    active: pkg.active,
    createdAt: pkg.createdAt.toISOString(),
  };
}

export interface SerializedBlockPurchase {
  id: string;
  memberUserId: string;
  packageId: string | null;
  hours: number;
  amountCents: number;
  note: string | null;
  purchasedAt: string;
}

function serializeBlockPurchase(p: BlockPurchaseView): SerializedBlockPurchase {
  return {
    id: p.id,
    memberUserId: p.memberUserId,
    packageId: p.packageId,
    hours: p.hours,
    amountCents: p.amountCents,
    note: p.note,
    purchasedAt: p.purchasedAt.toISOString(),
  };
}

export interface SerializedMemberBlockSummary {
  memberUserId: string;
  memberName: string;
  totalHoursPurchased: number;
  totalAmountPurchasedCents: number;
  prepaidBalanceCents: number;
  purchases: SerializedBlockPurchase[];
}

function serializeMemberBlockSummary(s: MemberBlockSummary): SerializedMemberBlockSummary {
  return {
    memberUserId: s.memberUserId,
    memberName: s.memberName,
    totalHoursPurchased: s.totalHoursPurchased,
    totalAmountPurchasedCents: s.totalAmountPurchasedCents,
    prepaidBalanceCents: s.prepaidBalanceCents,
    purchases: s.purchases.map(serializeBlockPurchase),
  };
}

// ─── listBlockPackagesAction ─────────────────────────────────────────────────

export type ListBlockPackagesActionResult =
  | { ok: true; packages: SerializedBlockPackage[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function listBlockPackagesAction(
  opts?: ListBlockPackagesOptions,
): Promise<ListBlockPackagesActionResult> {
  const session = await auth();
  try {
    const result = await listBlockPackages(session, opts);
    return { ok: true, packages: result.packages.map(serializeBlockPackage) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── createBlockPackageAction ────────────────────────────────────────────────

export type CreateBlockPackageActionResult =
  | { ok: true; package: SerializedBlockPackage }
  | ValidationErrorResult
  | AuthErrorResult
  | ServerErrorResult;

export async function createBlockPackageAction(
  input: { name: string; hours: number; priceCents: number },
  slug: string,
): Promise<CreateBlockPackageActionResult> {
  const session = await auth();
  try {
    const result = await createBlockPackage(session, input);
    revalidatePath(`/o/${slug}/billing/block-time`);
    return { ok: true, package: serializeBlockPackage(result.package) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── updateBlockPackageAction ─────────────────────────────────────────────────

export type UpdateBlockPackageActionResult =
  | { ok: true; package: SerializedBlockPackage }
  | { ok: false; reason: 'not_found' }
  | ValidationErrorResult
  | AuthErrorResult
  | ServerErrorResult;

export async function updateBlockPackageAction(
  input: {
    id: string;
    name?: string;
    hours?: number;
    priceCents?: number;
    active?: boolean;
  },
  slug: string,
): Promise<UpdateBlockPackageActionResult> {
  const session = await auth();
  try {
    const result = await updateBlockPackage(session, input);
    if (!result.ok) return result;
    revalidatePath(`/o/${slug}/billing/block-time`);
    return { ok: true, package: serializeBlockPackage(result.package) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── deactivateBlockPackageAction ────────────────────────────────────────────

export type DeactivateBlockPackageActionResult =
  | { ok: true; package: SerializedBlockPackage }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ServerErrorResult;

export async function deactivateBlockPackageAction(
  id: string,
  slug: string,
): Promise<DeactivateBlockPackageActionResult> {
  const session = await auth();
  try {
    const result = await deactivateBlockPackage(session, { id });
    if (!result.ok) return result;
    revalidatePath(`/o/${slug}/billing/block-time`);
    return { ok: true, package: serializeBlockPackage(result.package) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── listBillableMembersAction (member picker) ───────────────────────────────
// NOTE: listMembers requires people:access. Every role with billing:manage
// (owner/manager) also has people:access — see packages/core/src/capabilities.ts
// — so this is only ever called from the "Sell a block" form, itself gated to
// billing:manage in the UI (mirrors billing/pos/actions.ts's identical note).

export interface BillableMember {
  userId: string;
  displayName: string;
  email: string;
}

export type ListBillableMembersActionResult =
  | { ok: true; members: BillableMember[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function listBillableMembersAction(): Promise<ListBillableMembersActionResult> {
  const session = await auth();
  try {
    const members: OrgMemberListRow[] = await listMembers(session, {});
    return {
      ok: true,
      members: members.map((m) => ({
        userId: m.userId,
        displayName: m.displayName,
        email: m.email,
      })),
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── sellBlockToMemberAction ──────────────────────────────────────────────────

export type SellBlockToMemberActionResult =
  | { ok: true; purchase: SerializedBlockPurchase; balanceCentsAfter: number }
  | { ok: false; reason: 'member_not_found' | 'package_not_found' | 'package_inactive' }
  | ValidationErrorResult
  | AuthErrorResult
  | ServerErrorResult;

export async function sellBlockToMemberAction(
  input:
    | { memberId: string; packageId: string; note?: string }
    | { memberId: string; hours: number; amountCents: number; note?: string },
  slug: string,
): Promise<SellBlockToMemberActionResult> {
  const session = await auth();
  try {
    const result = await sellBlockToMember(session, input);
    if (!result.ok) return result;
    revalidatePath(`/o/${slug}/billing/block-time`);
    revalidatePath(`/o/${slug}/billing/block-time/${input.memberId}`);
    return {
      ok: true,
      purchase: serializeBlockPurchase(result.purchase),
      balanceCentsAfter: result.balanceCentsAfter,
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── getMemberBlockSummaryAction ──────────────────────────────────────────────

export type GetMemberBlockSummaryActionResult =
  | { ok: true; summary: SerializedMemberBlockSummary }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ServerErrorResult;

export async function getMemberBlockSummaryAction(
  memberId: string,
): Promise<GetMemberBlockSummaryActionResult> {
  const session = await auth();
  try {
    const result = await getMemberBlockSummary(session, { memberId });
    if (!result.ok) return result;
    return { ok: true, summary: serializeMemberBlockSummary(result.summary) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}
