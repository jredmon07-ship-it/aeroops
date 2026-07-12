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
  getMemberBalance,
  listLedgerEntries,
  recordManualPayment,
  issueCreditMemo,
  issueAdjustment,
  getMemberBillingProfile,
  createDuesSchedule,
  setDuesScheduleActive,
  generateDuesInvoices,
  sendNotification,
  listInvoiceableDispatch,
  listRateSchedules,
  generateInvoiceFromDispatch,
} from '@aeroops/api';
import type {
  InvoiceStatus,
  ListInvoicesOptions,
  LedgerEntryCursor,
  MemberBillingProfile,
} from '@aeroops/api';

// ─── Error shapes ──────────────────────────────────────────────────────────────

import { mapAuthError, mapActionError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ServerErrorResult };

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

    // Best-effort notifications (Slice P1.3) — fire AFTER finalize (and its
    // own autopay attempt) have already committed/completed. sendNotification
    // never throws; .catch here is defense-in-depth only.
    if (session) {
      await sendNotification(session, {
        toUserId: result.invoice.memberUserId,
        eventType: 'invoice.finalized',
        templateData: { invoiceId: result.invoice.id, totalCents: result.invoice.totalCents },
      }).catch(() => {});

      // 'payment.failed' — this codebase has no async Stripe webhook 'failed'
      // event (only *.succeeded is handled — see handle-webhook-event.ts); a
      // synchronous off-session decline (StripeCardDeclinedError) is the
      // actual payment-failure signal, surfaced here as autopay.outcome ===
      // 'declined'. Functionally equivalent hook point for this event.
      if (result.autopay?.outcome === 'declined') {
        await sendNotification(session, {
          toUserId: result.invoice.memberUserId,
          eventType: 'payment.failed',
          templateData: { invoiceId: result.invoice.id, amountCents: result.invoice.totalCents },
        }).catch(() => {});
      }
    }

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

// ─── Slice B2 — Ledger / balance / manual payments ──────────────────────────
// NO Stripe, NO card/bank data. Money = INTEGER CENTS. Read actions require
// billing:access; recordManualPaymentAction requires billing:manage
// (enforced inside the @aeroops/api command — this file never re-implements
// authz).

export type GetMemberBalanceActionResult =
  | { ok: true; balanceCents: number; minimumBalanceCents: number }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ServerErrorResult;

export async function getMemberBalanceAction(memberUserId: string): Promise<GetMemberBalanceActionResult> {
  const session = await auth();
  try {
    return await getMemberBalance(session, { memberUserId });
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

export interface SerializedLedgerEntry {
  id: string;
  entryType: 'invoice_finalized' | 'payment' | 'credit_memo' | 'adjustment' | 'block_purchase';
  direction: 'debit' | 'credit';
  amountCents: number;
  invoiceId: string | null;
  paymentId: string | null;
  memo: string | null;
  createdAt: string;
}

export type ListLedgerEntriesActionResult =
  | { ok: true; entries: SerializedLedgerEntry[]; nextCursor?: LedgerEntryCursor }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ServerErrorResult;

export async function listLedgerEntriesAction(
  memberUserId: string,
  cursor?: LedgerEntryCursor,
): Promise<ListLedgerEntriesActionResult> {
  const session = await auth();
  try {
    const result = await listLedgerEntries(session, { memberUserId, cursor });
    if (!result.ok) return result;
    return {
      ok: true,
      entries: result.entries.map((e) => ({
        id: e.id,
        entryType: e.entryType,
        direction: e.direction,
        amountCents: e.amountCents,
        invoiceId: e.invoiceId,
        paymentId: e.paymentId,
        memo: e.memo,
        createdAt: e.createdAt.toISOString(),
      })),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

export type RecordManualPaymentActionResult =
  | { ok: true; balanceCentsAfter: number }
  | { ok: false; reason: 'member_not_found' }
  | { error: 'validation'; message: string }
  | AuthErrorResult
  | ServerErrorResult;

export async function recordManualPaymentAction(
  memberUserId: string,
  amountCents: number,
  methodNote: string | undefined,
  slug: string,
): Promise<RecordManualPaymentActionResult> {
  const session = await auth();
  try {
    const result = await recordManualPayment(session, { memberUserId, amountCents, methodNote });
    if (!result.ok) return result;
    revalidatePath(`/o/${slug}/billing/accounts/${memberUserId}`);
    return { ok: true, balanceCentsAfter: result.balanceCentsAfter };
  } catch (err) {
    const mapped = mapActionError(err);
    if (mapped) return mapped;
    return { error: 'server' };
  }
}

// ─── FC-parity — credit memo / adjustment (billing corrections) ─────────────
// Both require billing:manage (enforced inside @aeroops/api). NO Stripe, NO
// card/bank data. Money = INTEGER CENTS. A correction is a NEW append-only
// ledger entry — nothing is ever edited or deleted.

export type IssueCreditMemoActionResult =
  | { ok: true; balanceCentsAfter: number }
  | { ok: false; reason: 'member_not_found' }
  | { error: 'validation'; message: string }
  | AuthErrorResult
  | ServerErrorResult;

export async function issueCreditMemoAction(
  memberUserId: string,
  amountCents: number,
  memo: string | undefined,
  slug: string,
): Promise<IssueCreditMemoActionResult> {
  const session = await auth();
  try {
    const result = await issueCreditMemo(session, { memberUserId, amountCents, memo });
    if (!result.ok) return result;
    revalidatePath(`/o/${slug}/billing/accounts/${memberUserId}`);
    return { ok: true, balanceCentsAfter: result.balanceCentsAfter };
  } catch (err) {
    const mapped = mapActionError(err);
    if (mapped) return mapped;
    return { error: 'server' };
  }
}

export type IssueAdjustmentActionResult =
  | { ok: true; balanceCentsAfter: number }
  | { ok: false; reason: 'member_not_found' }
  | { error: 'validation'; message: string }
  | AuthErrorResult
  | ServerErrorResult;

export async function issueAdjustmentAction(
  memberUserId: string,
  amountCents: number,
  direction: 'debit' | 'credit',
  memo: string,
  slug: string,
): Promise<IssueAdjustmentActionResult> {
  const session = await auth();
  try {
    const result = await issueAdjustment(session, { memberUserId, amountCents, direction, memo });
    if (!result.ok) return result;
    revalidatePath(`/o/${slug}/billing/accounts/${memberUserId}`);
    return { ok: true, balanceCentsAfter: result.balanceCentsAfter };
  } catch (err) {
    const mapped = mapActionError(err);
    if (mapped) return mapped;
    return { error: 'server' };
  }
}

// ─── Slice P0-REV — auto-pay status / saved-PM presence / recurring dues ────
// DISPLAY ONLY: getMemberBillingProfileAction never returns a PAN/CVV/account
// number — only Stripe-permitted last4/brand DISPLAY fields (see
// @aeroops/api's MemberBillingProfile shape). Dues create/run require
// billing:manage (enforced inside the @aeroops/api commands).

export type GetMemberBillingProfileActionResult =
  | { ok: true; profile: MemberBillingProfile }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ServerErrorResult;

export async function getMemberBillingProfileAction(memberUserId: string): Promise<GetMemberBillingProfileActionResult> {
  const session = await auth();
  try {
    return await getMemberBillingProfile(session, { memberUserId });
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

export type CreateDuesScheduleActionResult =
  | { ok: true }
  | { ok: false; reason: 'member_not_found' }
  | { error: 'validation'; message: string }
  | AuthErrorResult
  | ServerErrorResult;

export async function createDuesScheduleAction(
  memberUserId: string,
  amountCents: number,
  dayOfMonth: number,
  memo: string | undefined,
  slug: string,
): Promise<CreateDuesScheduleActionResult> {
  const session = await auth();
  try {
    const result = await createDuesSchedule(session, { memberUserId, amountCents, dayOfMonth, memo });
    if (!result.ok) return result;
    revalidatePath(`/o/${slug}/billing/accounts/${memberUserId}`);
    return { ok: true };
  } catch (err) {
    const mapped = mapActionError(err);
    if (mapped) return mapped;
    return { error: 'server' };
  }
}

export type SetDuesScheduleActiveActionResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ServerErrorResult;

export async function setDuesScheduleActiveAction(
  scheduleId: string,
  active: boolean,
  memberUserId: string,
  slug: string,
): Promise<SetDuesScheduleActiveActionResult> {
  const session = await auth();
  try {
    const result = await setDuesScheduleActive(session, { scheduleId, active });
    if (!result.ok) return result;
    revalidatePath(`/o/${slug}/billing/accounts/${memberUserId}`);
    return { ok: true };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

export type RunDuesForPeriodActionResult =
  | { ok: true; createdCount: number; skippedCount: number }
  | { error: 'validation'; message: string }
  | AuthErrorResult
  | ServerErrorResult;

/** runDuesForPeriodAction — manual trigger, billing:manage. Safe to call repeatedly (idempotent per period). */
export async function runDuesForPeriodAction(periodKey: string, slug: string): Promise<RunDuesForPeriodActionResult> {
  const session = await auth();
  try {
    const result = await generateDuesInvoices(session, { periodKey });
    revalidatePath(`/o/${slug}/billing`);

    // Best-effort notifications (Slice P1.3) — one per newly-created dues
    // invoice, fired AFTER the generate tx has already committed.
    if (session) {
      for (const created of result.created) {
        await sendNotification(session, {
          toUserId: created.userId,
          eventType: 'dues.generated',
          templateData: { invoiceId: created.invoiceId, periodKey, amountCents: created.amountCents },
        }).catch(() => {});
      }
    }

    return { ok: true, createdCount: result.created.length, skippedCount: result.skipped.length };
  } catch (err) {
    const mapped = mapActionError(err);
    if (mapped) return mapped;
    return { error: 'server' };
  }
}

// ─── Slice GAP2 — Generate invoice from a closed dispatch ticket ─────────────
// The "the invoice builds itself from the Hobbs reading" flow. All three actions
// gate INSIDE @aeroops/api (billing:manage for the worklist + generate;
// billing:access for the rate picker). MONEY = INTEGER CENTS; the DRAFT invoice
// is produced by the existing generateInvoiceFromDispatch — NO Stripe, NO charge,
// and the FROZEN dispatch gate/close path are untouched (read-only consumer).

export interface SerializedInvoiceableDispatchRow {
  dispatchTicketId: string;
  resourceId: string;
  tailNumber: string;
  pilotUserId: string;
  pilotName: string;
  flightTimeHours: number | null;
  closedAt: string | null;
}

export type ListInvoiceableDispatchActionResult =
  | { ok: true; rows: SerializedInvoiceableDispatchRow[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function listInvoiceableDispatchAction(): Promise<ListInvoiceableDispatchActionResult> {
  const session = await auth();
  try {
    const rows = await listInvoiceableDispatch(session);
    return {
      ok: true,
      rows: rows.map((r) => ({
        dispatchTicketId: r.dispatchTicketId,
        resourceId: r.resourceId,
        tailNumber: r.tailNumber,
        pilotUserId: r.pilotUserId,
        pilotName: r.pilotName,
        flightTimeHours: r.flightTimeHours,
        closedAt: r.closedAt ? r.closedAt.toISOString() : null,
      })),
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

export interface RatePickerOption {
  id: string;
  name: string;
  rateKind: string;
  amountCents: number;
}

export type ListRatePickerActionResult =
  | { ok: true; rates: RatePickerOption[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function listRatePickerAction(): Promise<ListRatePickerActionResult> {
  const session = await auth();
  try {
    const result = await listRateSchedules(session);
    return {
      ok: true,
      rates: result.rates.map((r) => ({
        id: r.id,
        name: r.name,
        rateKind: r.rateKind,
        amountCents: r.amountCents,
      })),
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

export type GenerateInvoiceFromDispatchActionResult =
  | { ok: true; invoiceId: string }
  | { ok: false; reason: 'ticket_not_found' | 'ticket_not_closed' | 'rate_not_found' }
  | { error: 'validation'; message: string }
  | AuthErrorResult
  | ServerErrorResult;

export async function generateInvoiceFromDispatchAction(
  input: { dispatchTicketId: string; rateScheduleId: string; memberUserId: string },
  slug: string,
): Promise<GenerateInvoiceFromDispatchActionResult> {
  const session = await auth();
  try {
    const result = await generateInvoiceFromDispatch(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    // The ticket is now invoiced — drop it from the "ready to invoice" worklist.
    revalidatePath(`/o/${slug}/billing`);
    return { ok: true, invoiceId: result.invoice.id };
  } catch (err) {
    const mapped = mapActionError(err);
    if (mapped) return mapped;
    return { error: 'server' };
  }
}
