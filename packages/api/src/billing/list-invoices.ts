/**
 * list-invoices.ts — Invoice reads: list + get (with line items).
 * (Slice B1 — read-only, billing:access)
 *
 * GUARANTEES:
 *   - authz FIRST: billing:access before any data access.
 *   - org_id from session only (RLS backstop).
 *   - NO money mutations here (read-only).
 *   - Exports toInvoiceView / toLineItemView for use by generate-invoice.ts
 *     and invoice-status-commands.ts (shared view builders).
 *
 * TWO CALLING FORMS per function:
 *   fn(session, opts?)           — app code.
 *   fnWithDb(db, session, opts?) — tests.
 */

import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { invoice, invoiceLineItem } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import type { InvoiceSelect } from '@aeroops/db';
import type { InvoiceLineItemSelect } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── View types ───────────────────────────────────────────────────────────────

export type InvoiceStatus = 'draft' | 'finalized' | 'void';

export interface InvoiceView {
  id:               string;
  orgId:            string;
  memberUserId:     string;
  status:           InvoiceStatus;
  subtotalCents:    number;
  totalCents:       number;
  dispatchTicketId: string | null;
  issuedAt:         Date | null;
  createdBy:        string;
  createdAt:        Date;
  updatedAt:        Date;
}

export interface InvoiceLineItemView {
  id:              string;
  orgId:           string;
  invoiceId:       string;
  description:     string;
  quantityHours:   number;
  unitAmountCents: number;
  lineTotalCents:  number;
  rateScheduleId:  string | null;
  createdAt:       Date;
}

// ─── Shared view builders (exported for generate-invoice + status-commands) ───

function parseDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}

export function toInvoiceView(row: InvoiceSelect): InvoiceView {
  return {
    id:               row.id,
    orgId:            row.orgId,
    memberUserId:     row.memberUserId,
    status:           row.status as InvoiceStatus,
    subtotalCents:    row.subtotalCents,
    totalCents:       row.totalCents,
    dispatchTicketId: row.dispatchTicketId ?? null,
    issuedAt:         parseDate(row.issuedAt),
    createdBy:        row.createdBy,
    createdAt:        parseDate(row.createdAt) ?? new Date(),
    updatedAt:        parseDate(row.updatedAt) ?? new Date(),
  };
}

export function toLineItemView(row: InvoiceLineItemSelect): InvoiceLineItemView {
  const qHours = typeof row.quantityHours === 'string'
    ? parseFloat(row.quantityHours)
    : (row.quantityHours as number);
  return {
    id:              row.id,
    orgId:           row.orgId,
    invoiceId:       row.invoiceId,
    description:     row.description,
    quantityHours:   Number.isFinite(qHours) ? qHours : 0,
    unitAmountCents: row.unitAmountCents,
    lineTotalCents:  row.lineTotalCents,
    rateScheduleId:  row.rateScheduleId ?? null,
    createdAt:       parseDate(row.createdAt) ?? new Date(),
  };
}

// ─── listInvoices ─────────────────────────────────────────────────────────────

export interface ListInvoicesOptions {
  status?:       InvoiceStatus;
  memberUserId?: string;
}

export interface ListInvoicesResult {
  invoices: InvoiceView[];
}

async function _listInvoicesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  options: ListInvoicesOptions = {},
): Promise<ListInvoicesResult> {
  requireCapability(session, 'billing:access');

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const conditions = [];
    if (options.status) {
      conditions.push(eq(invoice.status, options.status));
    }
    if (options.memberUserId) {
      if (!UUID_RE.test(options.memberUserId)) {
        throw new ValidationError('[billing] listInvoices: memberUserId must be a UUID');
      }
      conditions.push(eq(invoice.memberUserId, options.memberUserId));
    }

    const rows = conditions.length > 0
      ? await tx.select().from(invoice).where(and(...conditions)).orderBy(desc(invoice.createdAt))
      : await tx.select().from(invoice).orderBy(desc(invoice.createdAt));

    return { invoices: rows.map(toInvoiceView) };
  });
}

export async function listInvoices(
  session: AppSession | null | undefined,
  options: ListInvoicesOptions = {},
): Promise<ListInvoicesResult> {
  const db = await getDb();
  return _listInvoicesImpl(db, session, options);
}

export async function listInvoicesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  options: ListInvoicesOptions = {},
): Promise<ListInvoicesResult> {
  return _listInvoicesImpl(db, session, options);
}

// ─── getInvoice ───────────────────────────────────────────────────────────────

export interface GetInvoiceInput {
  id: string;
}

export type GetInvoiceResult =
  | { ok: true; invoice: InvoiceView; lineItems: InvoiceLineItemView[] }
  | { ok: false; reason: 'not_found' };

async function _getInvoiceImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GetInvoiceResult> {
  requireCapability(session, 'billing:access');

  const parsed = z.object({
    id: z.string().regex(UUID_RE, { message: 'id must be a UUID' }),
  }).safeParse(rawInput);

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid getInvoice input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { id } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const rows = await tx
      .select()
      .from(invoice)
      .where(eq(invoice.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return { ok: false, reason: 'not_found' } as const;
    }

    const lineRows = await tx
      .select()
      .from(invoiceLineItem)
      .where(eq(invoiceLineItem.invoiceId, id))
      .orderBy(invoiceLineItem.createdAt);

    return {
      ok: true,
      invoice: toInvoiceView(row),
      lineItems: lineRows.map(toLineItemView),
    };
  });
}

export async function getInvoice(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetInvoiceResult> {
  const db = await getDb();
  return _getInvoiceImpl(db, session, input);
}

export async function getInvoiceWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetInvoiceResult> {
  return _getInvoiceImpl(db, session, input);
}
