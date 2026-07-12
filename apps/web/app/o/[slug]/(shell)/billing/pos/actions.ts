/**
 * billing/pos/actions.ts — Server actions for POS / Counter Sales (Slice P2)
 * and the product catalog (also used by billing/catalog/page.tsx).
 *
 * Pattern mirrors billing/actions.ts:
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
 * MONEY BOUNDARY: all amounts are INTEGER CENTS. createCounterSaleAction only
 * ever creates a DRAFT invoice via the EXISTING B1 write path — NO money
 * moves here. finalizeCounterSaleAction is a thin wrapper over the EXISTING,
 * unchanged finalizeInvoice (billing/actions.ts's finalizeInvoiceAction does
 * the same thing for dispatch invoices — kept separate here only so the POS
 * flow can call "create & finalize" in one round trip without importing from
 * the sibling actions.ts).
 */
'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import {
  createProductCatalogItem,
  updateProductCatalogItem,
  listProductCatalogItems,
  deleteProductCatalogItem,
  createCounterSale,
  finalizeInvoice,
  listMembers,
} from '@aeroops/api';
import type {
  ProductCatalogView,
  ListProductCatalogItemsOptions,
  CounterSaleLineInput,
  InvoiceStatus,
  OrgMemberListRow,
} from '@aeroops/api';

// ─── Error shapes ──────────────────────────────────────────────────────────────

import { mapAuthError, isValidationError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ValidationErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ValidationErrorResult, ServerErrorResult };

// ─── Serialized types ──────────────────────────────────────────────────────────

export interface SerializedProductCatalogItem {
  id: string;
  name: string;
  unitPriceCents: number;
  sku: string | null;
  category: string | null;
  active: boolean;
  createdAt: string;
}

function serializeCatalogItem(item: ProductCatalogView): SerializedProductCatalogItem {
  return {
    id: item.id,
    name: item.name,
    unitPriceCents: item.unitPriceCents,
    sku: item.sku,
    category: item.category,
    active: item.active,
    createdAt: item.createdAt.toISOString(),
  };
}

// ─── listProductCatalogItemsAction ──────────────────────────────────────────

export type ListProductCatalogItemsActionResult =
  | { ok: true; items: SerializedProductCatalogItem[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function listProductCatalogItemsAction(
  opts?: ListProductCatalogItemsOptions,
): Promise<ListProductCatalogItemsActionResult> {
  const session = await auth();
  try {
    const result = await listProductCatalogItems(session, opts);
    return { ok: true, items: result.items.map(serializeCatalogItem) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── createProductCatalogItemAction ─────────────────────────────────────────

export type CreateProductCatalogItemActionResult =
  | { ok: true; item: SerializedProductCatalogItem }
  | ValidationErrorResult
  | AuthErrorResult
  | ServerErrorResult;

export async function createProductCatalogItemAction(
  input: {
    name: string;
    unitPriceCents: number;
    sku?: string;
    category?: string;
  },
  slug: string,
): Promise<CreateProductCatalogItemActionResult> {
  const session = await auth();
  try {
    const result = await createProductCatalogItem(session, input);
    revalidatePath(`/o/${slug}/billing/catalog`);
    return { ok: true, item: serializeCatalogItem(result.item) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── updateProductCatalogItemAction ─────────────────────────────────────────

export type UpdateProductCatalogItemActionResult =
  | { ok: true; item: SerializedProductCatalogItem }
  | { ok: false; reason: 'not_found' }
  | ValidationErrorResult
  | AuthErrorResult
  | ServerErrorResult;

export async function updateProductCatalogItemAction(
  input: {
    id: string;
    name?: string;
    unitPriceCents?: number;
    sku?: string | null;
    category?: string | null;
    active?: boolean;
  },
  slug: string,
): Promise<UpdateProductCatalogItemActionResult> {
  const session = await auth();
  try {
    const result = await updateProductCatalogItem(session, input);
    if (!result.ok) return result;
    revalidatePath(`/o/${slug}/billing/catalog`);
    return { ok: true, item: serializeCatalogItem(result.item) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── deleteProductCatalogItemAction ─────────────────────────────────────────

export type DeleteProductCatalogItemActionResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ServerErrorResult;

export async function deleteProductCatalogItemAction(
  id: string,
  slug: string,
): Promise<DeleteProductCatalogItemActionResult> {
  const session = await auth();
  try {
    const result = await deleteProductCatalogItem(session, { id });
    if (!result.ok) return result;
    revalidatePath(`/o/${slug}/billing/catalog`);
    return { ok: true };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── listBillableMembersAction (for the "Bill to member" picker) ───────────
// NOTE: listMembers requires people:access. Every role with billing:manage
// (owner/manager) also has people:access — see packages/core/src/capabilities.ts
// — so this is only ever called from the POS create form, which is itself
// gated to billing:manage in the UI (see pos/page.tsx).

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

// ─── createCounterSaleAction ─────────────────────────────────────────────────

export interface SerializedCounterSaleInvoice {
  id: string;
  status: InvoiceStatus;
  subtotalCents: number;
  totalCents: number;
  lineItems: Array<{
    id: string;
    description: string;
    unitAmountCents: number;
    lineTotalCents: number;
  }>;
}

export type CreateCounterSaleActionResult =
  | { ok: true; invoice: SerializedCounterSaleInvoice }
  | { ok: false; reason: 'member_not_found' | 'catalog_item_not_found' | 'catalog_item_inactive' }
  | ValidationErrorResult
  | AuthErrorResult
  | ServerErrorResult;

export async function createCounterSaleAction(
  memberId: string,
  lines: CounterSaleLineInput[],
  slug: string,
): Promise<CreateCounterSaleActionResult> {
  const session = await auth();
  try {
    const result = await createCounterSale(session, { memberId, lines });
    if (!result.ok) return result;
    revalidatePath(`/o/${slug}/billing`);
    return {
      ok: true,
      invoice: {
        id: result.invoice.id,
        status: result.invoice.status,
        subtotalCents: result.invoice.subtotalCents,
        totalCents: result.invoice.totalCents,
        lineItems: result.invoice.lineItems.map((l) => ({
          id: l.id,
          description: l.description,
          unitAmountCents: l.unitAmountCents,
          lineTotalCents: l.lineTotalCents,
        })),
      },
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── finalizeCounterSaleAction — thin wrapper over the EXISTING finalizeInvoice ─

export type FinalizeCounterSaleActionResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_draft' }
  | AuthErrorResult
  | ServerErrorResult;

export async function finalizeCounterSaleAction(
  invoiceId: string,
  slug: string,
): Promise<FinalizeCounterSaleActionResult> {
  const session = await auth();
  try {
    const result = await finalizeInvoice(session, { id: invoiceId });
    if (!result.ok) return result;
    revalidatePath(`/o/${slug}/billing`);
    revalidatePath(`/o/${slug}/billing/${invoiceId}`);
    return { ok: true };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}
