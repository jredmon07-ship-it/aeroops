/**
 * invoice-write-internal.ts — Shared tx-inner draft-invoice writer (Slice P2).
 *
 * Extracted so createCounterSale (counter-sale.ts) reuses the EXISTING B1
 * invoice write SHAPE instead of a bespoke INSERT — the resulting invoice is
 * byte-shape identical to what generate-invoice.ts produces, so it is
 * indistinguishable from a dispatch invoice to finalize/ledger/autopay/QBO.
 *
 * NOT adopted by generate-invoice.ts / generate-dues-invoices.ts in this
 * slice — those stay BYTE-STABLE (frozen; do not touch) to protect the
 * existing test baseline. Adopting them is an optional future cleanup.
 *
 * DOES NOT own caps/audit — the caller (createCounterSale) is responsible for
 * requireCapability + the audit_log row. DOES NOT run outside a tx — this
 * function only ever receives an already-open transaction.
 *
 * MONEY: INTEGER CENTS only. NO Stripe, NO card/bank data, NO money moved —
 * this only creates a DRAFT invoice record (status='draft').
 */

import { invoice, invoiceLineItem } from '@aeroops/db';
import type { AnyDb, InvoiceSelect, InvoiceLineItemSelect } from '@aeroops/db';
import { computeInvoiceTotals } from '@aeroops/core';
import type { AppSession } from '../auth/types.js';

export interface DraftInvoiceLineSpec {
  description:     string;
  quantityHours:   string; // stored in the numeric quantity column — a COUNT for POS lines, not hours.
  unitAmountCents: number;
  lineTotalCents:  number;
  rateScheduleId:  string | null;
}

export interface InsertDraftInvoiceWithLinesParams {
  memberUserId:     string;
  dispatchTicketId: string | null;
  lines:            DraftInvoiceLineSpec[];
}

export interface InsertDraftInvoiceWithLinesResult {
  invoiceRow: InvoiceSelect;
  lineRows:   InvoiceLineItemSelect[];
}

/**
 * insertDraftInvoiceWithLinesTx — INSERT one draft invoice + N line items,
 * in the CALLER's transaction. Byte-shape identical to generate-invoice.ts's
 * INSERT shape (status='draft', issuedAt=null, subtotal/total from
 * computeInvoiceTotals).
 *
 * @param tx      an already-open transaction (org GUC already set by the
 *                caller's withSessionOrgContextWithDb).
 * @param sess    the narrowed AppSession (for createdBy / orgId).
 * @param params  memberUserId (required — see [DECISION-1] in the P2 spec),
 *                dispatchTicketId (null for a counter sale), and lines.
 */
export async function insertDraftInvoiceWithLinesTx(
  tx: AnyDb,
  sess: AppSession,
  params: InsertDraftInvoiceWithLinesParams,
): Promise<InsertDraftInvoiceWithLinesResult> {
  const totals = computeInvoiceTotals(
    params.lines.map((l) => ({ lineTotalCents: l.lineTotalCents })),
  );

  const invoiceInserted = await tx
    .insert(invoice)
    .values({
      orgId:            sess.orgId,
      memberUserId:     params.memberUserId,
      status:           'draft',
      subtotalCents:    totals.subtotalCents,
      totalCents:       totals.totalCents,
      dispatchTicketId: params.dispatchTicketId,
      issuedAt:         null,
      createdBy:        sess.userId,
    })
    .returning();

  const invoiceRow = invoiceInserted[0];
  if (!invoiceRow) throw new Error('[billing] insertDraftInvoiceWithLinesTx: invoice INSERT returned no rows');

  const lineRows: InvoiceLineItemSelect[] = [];
  for (const line of params.lines) {
    const lineInserted = await tx
      .insert(invoiceLineItem)
      .values({
        orgId:           sess.orgId,
        invoiceId:       invoiceRow.id,
        description:     line.description,
        quantityHours:   line.quantityHours,
        unitAmountCents: line.unitAmountCents,
        lineTotalCents:  line.lineTotalCents,
        rateScheduleId:  line.rateScheduleId,
      })
      .returning();

    const lineRow = lineInserted[0];
    if (!lineRow) throw new Error('[billing] insertDraftInvoiceWithLinesTx: line item INSERT returned no rows');
    lineRows.push(lineRow);
  }

  return { invoiceRow, lineRows };
}
