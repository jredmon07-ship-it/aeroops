/**
 * billing/get-items-sold-report.ts — getItemsSoldReport (POS reporting).
 *
 * Per-product sell-through over a rolling UTC range: for each operator-defined
 * catalog product (product_catalog, migration 0031), how many units were sold
 * and the gross cents recognized, across FINALIZED invoices in the window.
 * READ-ONLY aggregate over EXISTING tables (product_catalog, invoice_line_item,
 * invoice) — NO new migration, NO schema change.
 *
 * ── METRIC DEFINITION (pin here — two people must compute the same number) ──
 *
 * A counter sale (counter-sale.ts) writes each catalog line into
 * invoice_line_item, SNAPSHOTTING the catalog item's name into `description`
 * and its price into `unit_amount_cents` — there is intentionally NO FK back to
 * product_catalog (0031 key guarantee (4): a later price change or hard-delete
 * never rewrites a historical sale). The only durable link is the name
 * snapshot, so this report joins invoice_line_item.description = product.name
 * within the same org.
 *
 * qtySold (per product) =
 *   Σ invoice_line_item.quantity_hours  (counter sales store the unit count in
 *   quantity_hours, e.g. 3 units → '3.0') for line items whose description
 *   matches the product name, on invoices with status='finalized' AND issued_at
 *   in [from, to) (half-open). "Sold" = recognized at finalize time — same
 *   basis as get-revenue-report's finalizedCents. Draft/void invoices excluded.
 *
 * grossCents (per product) =
 *   Σ invoice_line_item.line_total_cents over the same matched lines. INTEGER
 *   CENTS throughout — never a float.
 *
 * taxCents (per product) =
 *   ALWAYS 0 in this slice. The POS schema (0031) computes and stores NO tax —
 *   category/sku are free-text labels, not tax classes ([VERIFY-P2-A]: sales-
 *   tax collection/remittance posture is DEFERRED and must be resolved by
 *   compliance before tax lines ship). The field is surfaced so the report
 *   shape is stable when a tax slice later lands; today it is a documented zero.
 *
 * SCOPE / LIMITATIONS (honest): only currently-cataloged products appear — an
 *   ad-hoc counter-sale line (no catalog item) and a hard-deleted product's
 *   historical sales are NOT attributed to a product row (no durable link
 *   exists). A dispatch-derived flight line never matches a product name in
 *   practice; if an operator names a product identically to a flight-line
 *   description, that is an operator data choice, not a cross-tenant leak.
 *
 * AUTHZ: requireCapability('billing:access') FIRST — this is MONEY data
 *   (owner/manager/accountant), mirrors get-revenue-report.
 * TENANT ISOLATION: org_id from session only (withSessionOrgContextWithDb);
 *   product_catalog + invoice_line_item + invoice are RLS-scoped by the GUC —
 *   no additional org_id predicate needed (house convention).
 * READ-ONLY: zero writes, zero audit rows.
 * MONEY: integer cents throughout; NO float in the money path.
 *
 * TWO CALLING FORMS:
 *   getItemsSoldReport(session, input)          — app code.
 *   getItemsSoldReportWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { resolveReportRange } from '../reporting/internal.js';
import type { ReportRangeKey } from '../reporting/internal.js';
import { extractRows } from '../db-rows.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const ReportRangeKeySchema = z.enum(['7d', '30d', '90d', '180d', '365d']).default('30d');
const InputSchema = z.object({ range: ReportRangeKeySchema });

export type GetItemsSoldReportInput = { range?: ReportRangeKey | string };

// ─── Output types ─────────────────────────────────────────────────────────────

export interface ItemsSoldRow {
  productId: string;
  productName: string;
  sku: string | null;
  /** Units sold over the range (Σ quantity_hours on matched finalized lines). */
  qtySold: number;
  /** Σ line_total_cents. Integer cents. */
  grossCents: number;
  /** ALWAYS 0 — POS schema models no tax yet (see module METRIC DEFINITION). */
  taxCents: number;
}

export interface ItemsSoldReportResult {
  range: { key: ReportRangeKey; from: Date; to: Date };
  rows: ItemsSoldRow[];
  /** Σ qtySold across every product. */
  totalQtySold: number;
  /** Σ grossCents across every product. Integer cents. */
  totalGrossCents: number;
  /** Σ taxCents across every product — 0 in this slice. Integer cents. */
  totalTaxCents: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetItemsSoldReportInput,
): Promise<ItemsSoldReportResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:access');

  // 2. Validate range.
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(`Invalid range: ${parsed.error.message}`);
  const rangeKey = parsed.data.range as ReportRangeKey;

  // 3. Resolve window.
  const now = new Date();
  const { from, to } = resolveReportRange(rangeKey, now);
  // In raw sql`` templates, from/to are bound as ISO strings with an explicit
  // ::timestamptz cast (postgres-js cannot serialize a JS Date to db.execute()).

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // product_catalog (anchor) LEFT JOIN a subquery that pre-aggregates ONLY
    // the finalized, in-range counter-sale lines per description. The invoice
    // filter lives INSIDE the subquery's INNER JOIN so an out-of-range or
    // draft/void line never contributes — a plain LEFT JOIN + WHERE on the
    // outer query would leak such lines through the null-preserving side.
    // A product with zero sales in the window still appears (0 / $0.00).
    // RLS scopes every table to this org — no org_id predicate needed.
    const queryResult = await tx.execute(sql`
      SELECT
        pc.id                             AS "productId",
        pc.name                           AS "productName",
        pc.sku                            AS "sku",
        COALESCE(s."qty", 0)::numeric     AS "qtySoldRaw",
        COALESCE(s."gross", 0)::bigint    AS "grossCents"
      FROM product_catalog pc
      LEFT JOIN (
        SELECT
          li.description                          AS description,
          SUM(li.quantity_hours::numeric)         AS "qty",
          SUM(li.line_total_cents)                AS "gross"
        FROM invoice_line_item li
        JOIN invoice inv ON inv.id = li.invoice_id
        WHERE inv.status = 'finalized'
          AND inv.issued_at >= ${from.toISOString()}::timestamptz
          AND inv.issued_at <  ${to.toISOString()}::timestamptz
        GROUP BY li.description
      ) s ON s.description = pc.name
      ORDER BY "grossCents" DESC, pc.name ASC
    `);

    const rawRows = extractRows<{
      productId: string;
      productName: string;
      sku: string | null;
      qtySoldRaw: number | string;
      grossCents: number | string;
    }>(queryResult);

    let totalQtySold = 0;
    let totalGrossCents = 0;

    const rows: ItemsSoldRow[] = rawRows.map((r) => {
      // Products with no finalized in-range sales come back NULL from the LEFT
      // JOIN → COALESCE 0 in SQL; Number(... ?? 0) is a belt-and-suspenders guard.
      const qtySold = Math.round(Number(r.qtySoldRaw ?? 0) * 10) / 10;
      const grossCents = Number(r.grossCents ?? 0);
      totalQtySold += qtySold;
      totalGrossCents += grossCents;
      return {
        productId: r.productId,
        productName: r.productName,
        sku: r.sku,
        qtySold,
        grossCents,
        taxCents: 0,
      };
    });

    return {
      range: { key: rangeKey, from, to },
      rows,
      totalQtySold: Math.round(totalQtySold * 10) / 10,
      totalGrossCents,
      totalTaxCents: 0,
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getItemsSoldReport(
  session: AppSession | null | undefined,
  rawInput: GetItemsSoldReportInput = {},
): Promise<ItemsSoldReportResult> {
  const db = await getDb();
  return _impl(db, session, rawInput);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getItemsSoldReportWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetItemsSoldReportInput = {},
): Promise<ItemsSoldReportResult> {
  return _impl(db, session, rawInput);
}
