/**
 * counter-sale.ts — createCounterSale (Slice P2 — POS / counter sales).
 *
 * Sell non-flight catalog items (headsets, charts, fuel, merch) — or an
 * ad-hoc line — to a member as a DRAFT invoice. Rides the EXISTING B1
 * invoice write path via insertDraftInvoiceWithLinesTx (invoice-write-
 * internal.ts) — NO bespoke invoice INSERT. Finalization is NOT part of this
 * command: the caller finalizes via the EXISTING, unchanged finalizeInvoice
 * (invoice-status-commands.ts), which posts the B2 ledger debit and (with a
 * saved PM + autopay) triggers autopay identically to a dispatch invoice.
 *
 * [DECISION-1] memberId is REQUIRED (not optional). invoice.member_user_id
 * is NOT NULL with a composite FK to app_user (frozen B1 table, migration
 * 0019); the B2 ledger debit and P0 autopay both key off that member. A true
 * walk-in / no-account sale is a DEFERRED forward seam (see
 * docs/specs/slice-p2-pos.md).
 *
 * MONEY: INTEGER CENTS only via computeCounterSaleLineTotal (@aeroops/core —
 * exact integer product, no rounding). NO Stripe, NO card/bank data, NO
 * money moved by this command — it only drafts a record.
 *
 * GUARANTEES:
 *   - AUTHZ FIRST: billing:manage.
 *   - org_id from session only (RLS backstop).
 *   - member + catalog items resolved via RLS-scoped SELECT inside the tx —
 *     a cross-org id is indistinguishable from a truly absent one
 *     (member_not_found / catalog_item_not_found; no enumeration).
 *   - inactive catalog items are refused (catalog_item_inactive), never
 *     silently priced.
 *   - ONE audit row per successful sale: 'billing.counter_sale_created'.
 *   - Empty lines / non-positive quantity / non-integer price → ValidationError.
 *
 * TWO CALLING FORMS:
 *   createCounterSale(session, input)          — app code.
 *   createCounterSaleWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { appUser, productCatalog, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { computeCounterSaleLineTotal } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { insertDraftInvoiceWithLinesTx } from './invoice-write-internal.js';
import { toInvoiceView, toLineItemView } from './list-invoices.js';
import type { InvoiceView, InvoiceLineItemView } from './list-invoices.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Input schema ─────────────────────────────────────────────────────────────

const catalogLineSchema = z.object({
  catalogItemId: z.string().regex(UUID_RE, { message: 'catalogItemId must be a UUID' }),
  quantity:      z.number().int({ message: 'quantity must be an integer' }).positive({ message: 'quantity must be > 0' }),
});

const adhocLineSchema = z.object({
  name:           z.string().min(1, { message: 'name must not be empty' }),
  unitPriceCents: z.number().int({ message: 'unitPriceCents must be an integer' }).positive({ message: 'unitPriceCents must be > 0' }),
  quantity:       z.number().int({ message: 'quantity must be an integer' }).positive({ message: 'quantity must be > 0' }),
});

const counterSaleLineSchema = z.union([catalogLineSchema, adhocLineSchema]);

export type CounterSaleLineInput = z.infer<typeof counterSaleLineSchema>;

const createCounterSaleInputSchema = z.object({
  memberId: z.string().regex(UUID_RE, { message: 'memberId must be a UUID' }),
  lines:    z.array(counterSaleLineSchema).min(1, { message: 'lines must not be empty' }),
});

export type CreateCounterSaleInput = z.infer<typeof createCounterSaleInputSchema>;

function isCatalogLine(l: CounterSaleLineInput): l is z.infer<typeof catalogLineSchema> {
  return 'catalogItemId' in l;
}

// ─── Result type ──────────────────────────────────────────────────────────────

export type CreateCounterSaleResult =
  | { ok: true; invoice: InvoiceView & { lineItems: InvoiceLineItemView[] } }
  | { ok: false; reason: 'member_not_found' | 'catalog_item_not_found' | 'catalog_item_inactive' };

// ─── Shared implementation ────────────────────────────────────────────────────

async function _createCounterSaleImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CreateCounterSaleResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:manage');

  // 2. VALIDATE input.
  const parsed = createCounterSaleInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid createCounterSale input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { memberId, lines } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Resolve member (RLS-scoped — cross-org id is invisible, not just forbidden).
    const memberRows = await tx
      .select({ id: appUser.id })
      .from(appUser)
      .where(eq(appUser.id, memberId))
      .limit(1);
    if (!memberRows[0]) {
      return { ok: false, reason: 'member_not_found' } as const;
    }

    // 4. Resolve + price each line.
    const draftLines: Array<{
      description: string;
      quantityHours: string;
      unitAmountCents: number;
      lineTotalCents: number;
      rateScheduleId: null;
      catalogItemId: string | null;
      quantity: number;
    }> = [];

    for (const line of lines) {
      if (isCatalogLine(line)) {
        const catalogRows = await tx
          .select({
            id: productCatalog.id,
            name: productCatalog.name,
            unitPriceCents: productCatalog.unitPriceCents,
            active: productCatalog.active,
          })
          .from(productCatalog)
          .where(eq(productCatalog.id, line.catalogItemId))
          .limit(1);
        const catalogItem = catalogRows[0];
        if (!catalogItem) {
          return { ok: false, reason: 'catalog_item_not_found' } as const;
        }
        if (!catalogItem.active) {
          return { ok: false, reason: 'catalog_item_inactive' } as const;
        }
        const lineTotalCents = computeCounterSaleLineTotal(line.quantity, catalogItem.unitPriceCents);
        draftLines.push({
          description:     catalogItem.name.trim(),
          quantityHours:   line.quantity.toFixed(1),
          unitAmountCents: catalogItem.unitPriceCents,
          lineTotalCents,
          rateScheduleId:  null,
          catalogItemId:   catalogItem.id,
          quantity:        line.quantity,
        });
      } else {
        const lineTotalCents = computeCounterSaleLineTotal(line.quantity, line.unitPriceCents);
        draftLines.push({
          description:     line.name.trim(),
          quantityHours:   line.quantity.toFixed(1),
          unitAmountCents: line.unitPriceCents,
          lineTotalCents,
          rateScheduleId:  null,
          catalogItemId:   null,
          quantity:        line.quantity,
        });
      }
    }

    // 5. Insert the draft invoice + line items via the shared, frozen-shape writer.
    const { invoiceRow, lineRows } = await insertDraftInvoiceWithLinesTx(tx, sess, {
      memberUserId:     memberId,
      dispatchTicketId: null,
      lines: draftLines.map((l) => ({
        description:     l.description,
        quantityHours:   l.quantityHours,
        unitAmountCents: l.unitAmountCents,
        lineTotalCents:  l.lineTotalCents,
        rateScheduleId:  l.rateScheduleId,
      })),
    });

    // 6. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'billing.counter_sale_created',
      entityType:  'invoice',
      entityId:    invoiceRow.id,
      metadata: {
        invoiceId:     invoiceRow.id,
        memberUserId:  memberId,
        lineCount:     draftLines.length,
        subtotalCents: invoiceRow.subtotalCents,
        totalCents:    invoiceRow.totalCents,
        lines: draftLines.map((l) => ({
          catalogItemId:   l.catalogItemId,
          name:            l.description,
          quantity:        l.quantity,
          unitAmountCents: l.unitAmountCents,
          lineTotalCents:  l.lineTotalCents,
        })),
      },
    });

    return {
      ok: true,
      invoice: {
        ...toInvoiceView(invoiceRow),
        lineItems: lineRows.map(toLineItemView),
      },
    } as const;
  });
}

export async function createCounterSale(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateCounterSaleResult> {
  const db = await getDb();
  return _createCounterSaleImpl(db, session, input);
}

export async function createCounterSaleWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateCounterSaleResult> {
  return _createCounterSaleImpl(db, session, input);
}
