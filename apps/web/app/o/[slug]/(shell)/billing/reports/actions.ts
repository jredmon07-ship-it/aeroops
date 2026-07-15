/**
 * billing/reports/actions.ts — Server actions for the Financial/AR reporting
 * slice (Accounts receivable, Revenue, Member statement).
 *
 * Pattern mirrors billing/actions.ts + reporting/reports/actions.ts:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability('billing:access') is enforced
 *      INSIDE the fn — this file never re-implements authz).
 *   3. Map ForbiddenError/UnauthenticatedError → tagged error result.
 *   4. Map ValidationError → { error: 'validation', message }.
 *   5. Dates serialized to ISO strings at the action boundary (Dates are not
 *      JSON-serializable across the RSC → client boundary).
 *
 * BOUNDARY: imports ONLY from '@aeroops/api' — NEVER '@aeroops/db'.
 * MONEY: every amount is INTEGER CENTS, read-only (no write action here).
 * [VERIFY] OPERATIONAL financial reporting — NOT a tax/GAAP/audit determination.
 */
'use server';

import { auth } from '@/auth';
import {
  getAccountsReceivable,
  getRevenueReport,
  getUnbilledFlights,
  getMemberStatement,
  getItemsSoldReport,
  getPaymentsReport,
  getAdjustmentsReport,
  getTaxesOwedReport,
} from '@aeroops/api';
import type {
  AccountsReceivableRow,
  RevenueReportBucket,
  ItemsSoldRow,
  InvoiceStatus,
  PaymentReportRow,
  AdjustmentReportRow,
  TaxesOwedReportBucket,
} from '@aeroops/api';

// ─── Error shapes ──────────────────────────────────────────────────────────────

import { mapAuthError, isValidationError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ValidationErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ValidationErrorResult, ServerErrorResult };

// ─── getUnbilledFlightsAction ───────────────────────────────────────────────

export interface SerializedUnbilledFlight {
  ticketId: string;
  resourceId: string;
  tailNumber: string;
  pilotName: string | null;
  closedAt: string;
  flightTimeHours: number;
}

export interface SerializedUnbilledFlights {
  range: { key: string; from: string; to: string };
  flights: SerializedUnbilledFlight[];
  totalCount: number;
  totalHours: number;
  truncated: boolean;
}

export type GetUnbilledFlightsActionResult =
  | { ok: true; data: SerializedUnbilledFlights }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getUnbilledFlightsAction(
  range?: string,
): Promise<GetUnbilledFlightsActionResult> {
  const session = await auth();
  try {
    const result = await getUnbilledFlights(session, { range });
    return {
      ok: true,
      data: {
        range: {
          key: result.range.key,
          from: result.range.from.toISOString(),
          to: result.range.to.toISOString(),
        },
        flights: result.flights.map((f) => ({
          ticketId: f.ticketId,
          resourceId: f.resourceId,
          tailNumber: f.tailNumber,
          pilotName: f.pilotName,
          closedAt: f.closedAt.toISOString(),
          flightTimeHours: f.flightTimeHours,
        })),
        totalCount: result.totalCount,
        totalHours: result.totalHours,
        truncated: result.truncated,
      },
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── getAccountsReceivableAction ────────────────────────────────────────────

export interface SerializedAgingBuckets {
  current: number;
  d30: number;
  d60: number;
  d90: number;
  d90plus: number;
}

export interface SerializedAccountsReceivableRow {
  memberUserId: string;
  memberName: string;
  balanceCents: number;
  aging: SerializedAgingBuckets;
}

export interface SerializedAccountsReceivable {
  asOf: string;
  rows: SerializedAccountsReceivableRow[];
  totals: SerializedAgingBuckets;
  totalOutstandingCents: number;
}

function serializeAgingRow(r: AccountsReceivableRow): SerializedAccountsReceivableRow {
  return {
    memberUserId: r.memberUserId,
    memberName: r.memberName,
    balanceCents: r.balanceCents,
    aging: { ...r.aging },
  };
}

export type GetAccountsReceivableActionResult =
  | { ok: true; data: SerializedAccountsReceivable }
  | AuthErrorResult
  | ServerErrorResult;

export async function getAccountsReceivableAction(): Promise<GetAccountsReceivableActionResult> {
  const session = await auth();
  try {
    const result = await getAccountsReceivable(session);
    return {
      ok: true,
      data: {
        asOf: result.asOf.toISOString(),
        rows: result.rows.map(serializeAgingRow),
        totals: { ...result.totals },
        totalOutstandingCents: result.totalOutstandingCents,
      },
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── getRevenueReportAction ──────────────────────────────────────────────────

export interface SerializedRevenueReportBucket {
  bucketStart: string;
  finalizedCents: number;
  collectedCents: number;
}

export interface SerializedRevenueReport {
  range: { key: string; from: string; to: string };
  granularity: string;
  buckets: SerializedRevenueReportBucket[];
  totalFinalizedCents: number;
  totalCollectedCents: number;
}

function serializeRevenueBucket(b: RevenueReportBucket): SerializedRevenueReportBucket {
  return {
    bucketStart: b.bucketStart.toISOString(),
    finalizedCents: b.finalizedCents,
    collectedCents: b.collectedCents,
  };
}

export type GetRevenueReportActionResult =
  | { ok: true; data: SerializedRevenueReport }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getRevenueReportAction(
  range?: string,
): Promise<GetRevenueReportActionResult> {
  const session = await auth();
  try {
    const result = await getRevenueReport(session, { range });
    return {
      ok: true,
      data: {
        range: {
          key: result.range.key,
          from: result.range.from.toISOString(),
          to: result.range.to.toISOString(),
        },
        granularity: result.granularity,
        buckets: result.buckets.map(serializeRevenueBucket),
        totalFinalizedCents: result.totalFinalizedCents,
        totalCollectedCents: result.totalCollectedCents,
      },
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── getItemsSoldReportAction ────────────────────────────────────────────────

export interface SerializedItemsSoldRow {
  productId: string;
  productName: string;
  sku: string | null;
  qtySold: number;
  grossCents: number;
  taxCents: number;
}

export interface SerializedItemsSoldReport {
  range: { key: string; from: string; to: string };
  rows: SerializedItemsSoldRow[];
  totalQtySold: number;
  totalGrossCents: number;
  totalTaxCents: number;
}

function serializeItemsSoldRow(r: ItemsSoldRow): SerializedItemsSoldRow {
  return {
    productId: r.productId,
    productName: r.productName,
    sku: r.sku,
    qtySold: r.qtySold,
    grossCents: r.grossCents,
    taxCents: r.taxCents,
  };
}

export type GetItemsSoldReportActionResult =
  | { ok: true; data: SerializedItemsSoldReport }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getItemsSoldReportAction(
  range?: string,
): Promise<GetItemsSoldReportActionResult> {
  const session = await auth();
  try {
    const result = await getItemsSoldReport(session, { range });
    return {
      ok: true,
      data: {
        range: {
          key: result.range.key,
          from: result.range.from.toISOString(),
          to: result.range.to.toISOString(),
        },
        rows: result.rows.map(serializeItemsSoldRow),
        totalQtySold: result.totalQtySold,
        totalGrossCents: result.totalGrossCents,
        totalTaxCents: result.totalTaxCents,
      },
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── getPaymentsReportAction ─────────────────────────────────────────────────

export interface SerializedPaymentReportRow {
  entryId: string;
  createdAt: string;
  memberUserId: string;
  memberName: string;
  amountCents: number;
  paymentId: string | null;
  memo: string | null;
}

export interface SerializedPaymentsReport {
  range: { key: string; from: string; to: string };
  rows: SerializedPaymentReportRow[];
  totalPaymentCents: number;
  paymentCount: number;
}

function serializePaymentRow(r: PaymentReportRow): SerializedPaymentReportRow {
  return {
    entryId: r.entryId,
    createdAt: r.createdAt.toISOString(),
    memberUserId: r.memberUserId,
    memberName: r.memberName,
    amountCents: r.amountCents,
    paymentId: r.paymentId,
    memo: r.memo,
  };
}

export type GetPaymentsReportActionResult =
  | { ok: true; data: SerializedPaymentsReport }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getPaymentsReportAction(range?: string): Promise<GetPaymentsReportActionResult> {
  const session = await auth();
  try {
    const result = await getPaymentsReport(session, { range });
    return {
      ok: true,
      data: {
        range: {
          key: result.range.key,
          from: result.range.from.toISOString(),
          to: result.range.to.toISOString(),
        },
        rows: result.rows.map(serializePaymentRow),
        totalPaymentCents: result.totalPaymentCents,
        paymentCount: result.paymentCount,
      },
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── getAdjustmentsReportAction ──────────────────────────────────────────────

export interface SerializedAdjustmentReportRow {
  entryId: string;
  createdAt: string;
  memberUserId: string;
  memberName: string;
  entryType: 'credit_memo' | 'adjustment';
  direction: 'debit' | 'credit';
  amountCents: number;
  memo: string | null;
  createdByName: string | null;
}

export interface SerializedAdjustmentsReport {
  range: { key: string; from: string; to: string };
  rows: SerializedAdjustmentReportRow[];
  totalCreditCents: number;
  totalDebitCents: number;
  count: number;
}

function serializeAdjustmentRow(r: AdjustmentReportRow): SerializedAdjustmentReportRow {
  return {
    entryId: r.entryId,
    createdAt: r.createdAt.toISOString(),
    memberUserId: r.memberUserId,
    memberName: r.memberName,
    entryType: r.entryType,
    direction: r.direction,
    amountCents: r.amountCents,
    memo: r.memo,
    createdByName: r.createdByName,
  };
}

export type GetAdjustmentsReportActionResult =
  | { ok: true; data: SerializedAdjustmentsReport }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getAdjustmentsReportAction(
  range?: string,
): Promise<GetAdjustmentsReportActionResult> {
  const session = await auth();
  try {
    const result = await getAdjustmentsReport(session, { range });
    return {
      ok: true,
      data: {
        range: {
          key: result.range.key,
          from: result.range.from.toISOString(),
          to: result.range.to.toISOString(),
        },
        rows: result.rows.map(serializeAdjustmentRow),
        totalCreditCents: result.totalCreditCents,
        totalDebitCents: result.totalDebitCents,
        count: result.count,
      },
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── getTaxesOwedReportAction ────────────────────────────────────────────────

export interface SerializedTaxesOwedReportBucket {
  bucketStart: string;
  taxableGrossCents: number;
  taxCents: number;
}

export interface SerializedTaxesOwedReport {
  range: { key: string; from: string; to: string };
  granularity: string;
  buckets: SerializedTaxesOwedReportBucket[];
  totalTaxableGrossCents: number;
  totalTaxCents: number;
}

function serializeTaxesBucket(b: TaxesOwedReportBucket): SerializedTaxesOwedReportBucket {
  return {
    bucketStart: b.bucketStart.toISOString(),
    taxableGrossCents: b.taxableGrossCents,
    taxCents: b.taxCents,
  };
}

export type GetTaxesOwedReportActionResult =
  | { ok: true; data: SerializedTaxesOwedReport }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getTaxesOwedReportAction(
  range?: string,
): Promise<GetTaxesOwedReportActionResult> {
  const session = await auth();
  try {
    const result = await getTaxesOwedReport(session, { range });
    return {
      ok: true,
      data: {
        range: {
          key: result.range.key,
          from: result.range.from.toISOString(),
          to: result.range.to.toISOString(),
        },
        granularity: result.granularity,
        buckets: result.buckets.map(serializeTaxesBucket),
        totalTaxableGrossCents: result.totalTaxableGrossCents,
        totalTaxCents: result.totalTaxCents,
      },
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── getMemberStatementAction ────────────────────────────────────────────────

export interface SerializedStatementInvoice {
  id: string;
  status: InvoiceStatus;
  subtotalCents: number;
  totalCents: number;
  issuedAt: string | null;
  createdAt: string;
}

export interface SerializedStatementLedgerRow {
  id: string;
  entryType: string;
  direction: 'debit' | 'credit';
  amountCents: number;
  invoiceId: string | null;
  paymentId: string | null;
  memo: string | null;
  createdAt: string;
  runningBalanceCents: number;
}

export interface SerializedMemberStatement {
  memberUserId: string;
  memberName: string;
  invoices: SerializedStatementInvoice[];
  ledger: SerializedStatementLedgerRow[];
  endingBalanceCents: number;
}

export type GetMemberStatementActionResult =
  | { ok: true; statement: SerializedMemberStatement }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getMemberStatementAction(
  memberId: string,
): Promise<GetMemberStatementActionResult> {
  const session = await auth();
  try {
    const result = await getMemberStatement(session, { memberId });
    if (!result.ok) return result;
    const { statement } = result;
    return {
      ok: true,
      statement: {
        memberUserId: statement.memberUserId,
        memberName: statement.memberName,
        invoices: statement.invoices.map((inv) => ({
          id: inv.id,
          status: inv.status,
          subtotalCents: inv.subtotalCents,
          totalCents: inv.totalCents,
          issuedAt: inv.issuedAt?.toISOString() ?? null,
          createdAt: inv.createdAt.toISOString(),
        })),
        ledger: statement.ledger.map((l) => ({
          id: l.id,
          entryType: l.entryType,
          direction: l.direction,
          amountCents: l.amountCents,
          invoiceId: l.invoiceId,
          paymentId: l.paymentId,
          memo: l.memo,
          createdAt: l.createdAt.toISOString(),
          runningBalanceCents: l.runningBalanceCents,
        })),
        endingBalanceCents: statement.endingBalanceCents,
      },
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}
