/**
 * billing/actions.ts — Server actions for the Billing hub (Slice B1 reads/
 * status + Slice QB1 export).
 *
 * Pattern mirrors booking/actions.ts + people/actions.ts:
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
 * MONEY BOUNDARY: all amounts are INTEGER CENTS, read-only here except the
 * status transitions (finalize/void, unchanged from Slice B1) and the new
 * QB1 export action, which NEVER moves money — it pushes an existing
 * finalized invoice record into the operator's own connected QuickBooks
 * Online company file as a bookkeeping export.
 */
'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import {
  listInvoices,
  getInvoice,
  finalizeInvoice,
  voidInvoice,
  exportInvoiceToQbo,
  ForbiddenError,
  UnauthenticatedError,
} from '@aeroops/api';
import type { InvoiceStatus, ListInvoicesOptions } from '@aeroops/api';

// ─── Error shapes ──────────────────────────────────────────────────────────────

export type AuthErrorResult = { error: 'forbidden' } | { error: 'unauthenticated' };
export type ServerErrorResult = { error: 'server'; message?: string };

function mapAuthError(err: unknown): AuthErrorResult | null {
  if (err instanceof ForbiddenError) return { error: 'forbidden' };
  if (err instanceof UnauthenticatedError) return { error: 'unauthenticated' };
  return null;
}

// ─── Serialized types ──────────────────────────────────────────────────────────

export interface SerializedInvoiceRow {
  id: string;
  memberUserId: string;
  status: InvoiceStatus;
  subtotalCents: number;
  totalCents: number;
  dispatchTicketId: string | null;
  issuedAt: string | null;
  createdAt: string;
}

export interface SerializedInvoiceLineItem {
  id: string;
  description: string;
  quantityHours: number;
  unitAmountCents: number;
  lineTotalCents: number;
  rateScheduleId: string | null;
}

function serializeInvoice(inv: {
  id: string;
  memberUserId: string;
  status: InvoiceStatus;
  subtotalCents: number;
  totalCents: number;
  dispatchTicketId: string | null;
  issuedAt: Date | null;
  createdAt: Date;
}): SerializedInvoiceRow {
  return {
    id: inv.id,
    memberUserId: inv.memberUserId,
    status: inv.status,
    subtotalCents: inv.subtotalCents,
    totalCents: inv.totalCents,
    dispatchTicketId: inv.dispatchTicketId,
    issuedAt: inv.issuedAt?.toISOString() ?? null,
    createdAt: inv.createdAt.toISOString(),
  };
}

// ─── listInvoicesAction ─────────────────────────────────────────────────────

export type ListInvoicesActionResult =
  | { ok: true; invoices: SerializedInvoiceRow[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function listInvoicesAction(opts?: ListInvoicesOptions): Promise<ListInvoicesActionResult> {
  const session = await auth();
  try {
    const result = await listInvoices(session, opts);
    return { ok: true, invoices: result.invoices.map(serializeInvoice) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── getInvoiceAction ───────────────────────────────────────────────────────

export type GetInvoiceActionResult =
  | { ok: true; invoice: SerializedInvoiceRow; lineItems: SerializedInvoiceLineItem[] }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ServerErrorResult;

export async function getInvoiceAction(id: string): Promise<GetInvoiceActionResult> {
  const session = await auth();
  try {
    const result = await getInvoice(session, { id });
    if (!result.ok) return { ok: false, reason: result.reason };
    return {
      ok: true,
      invoice: serializeInvoice(result.invoice),
      lineItems: result.lineItems.map((l) => ({
        id: l.id,
        description: l.description,
        quantityHours: l.quantityHours,
        unitAmountCents: l.unitAmountCents,
        lineTotalCents: l.lineTotalCents,
        rateScheduleId: l.rateScheduleId,
      })),
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── finalizeInvoiceAction ──────────────────────────────────────────────────

export type FinalizeInvoiceActionResult =
  | { ok: true; invoice: SerializedInvoiceRow }
  | { ok: false; reason: 'not_found' | 'not_draft' }
  | AuthErrorResult
  | ServerErrorResult;

export async function finalizeInvoiceAction(id: string, slug: string): Promise<FinalizeInvoiceActionResult> {
  const session = await auth();
  try {
    const result = await finalizeInvoice(session, { id });
    if (!result.ok) return { ok: false, reason: result.reason };
    revalidatePath(`/o/${slug}/billing/${id}`);
    return { ok: true, invoice: serializeInvoice(result.invoice) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── voidInvoiceAction ──────────────────────────────────────────────────────

export type VoidInvoiceActionResult =
  | { ok: true; invoice: SerializedInvoiceRow }
  | { ok: false; reason: 'not_found' | 'already_void' }
  | AuthErrorResult
  | ServerErrorResult;

export async function voidInvoiceAction(id: string, slug: string): Promise<VoidInvoiceActionResult> {
  const session = await auth();
  try {
    const result = await voidInvoice(session, { id });
    if (!result.ok) return { ok: false, reason: result.reason };
    revalidatePath(`/o/${slug}/billing/${id}`);
    return { ok: true, invoice: serializeInvoice(result.invoice) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── exportInvoiceToQboAction (Slice QB1) ───────────────────────────────────

export type ExportInvoiceToQboActionResult =
  | { ok: true; qboInvoiceId: string; alreadyExported: boolean }
  | { ok: false; reason: 'not_configured' | 'not_connected' | 'not_found' | 'not_finalized' }
  | { ok: false; reason: 'unmapped_kinds'; kinds: string[] }
  | { ok: false; reason: 'provider_error'; message: string }
  | AuthErrorResult
  | ServerErrorResult;

export async function exportInvoiceToQboAction(
  invoiceId: string,
  slug: string,
): Promise<ExportInvoiceToQboActionResult> {
  const session = await auth();
  try {
    const result = await exportInvoiceToQbo(session, { invoiceId });
    if (result.ok) {
      revalidatePath(`/o/${slug}/billing/${invoiceId}`);
    }
    return result;
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}
