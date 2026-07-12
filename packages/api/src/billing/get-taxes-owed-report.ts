/**
 * billing/get-taxes-owed-report.ts — getTaxesOwedReport (FC canned-report menu).
 *
 * Sales-tax collected over a rolling UTC range, bucketed by period, over
 * point-of-sale (counter-sale) activity. READ-ONLY aggregate over EXISTING
 * tables (invoice, invoice_line_item, product_catalog) — NO new migration.
 *
 * ── SCOPE + HONEST LIMITATION (READ THIS) ────────────────────────────────────
 *
 * The schema models NO tax. Neither `invoice` nor `invoice_line_item` carries a
 * tax column, and the POS slice (migration 0031) explicitly "computes NO tax
 * and makes NO tax determination — category/sku are FREE-TEXT operator labels,
 * not tax classes" ([VERIFY-P2-A]: sales-tax collection/remittance is a deferred
 * item that must be resolved by compliance before tax lines ship).
 *
 * Therefore this report is SCOPED TO POS and reports:
 *   posTaxCents        — ALWAYS 0 in this build (a documented zero, surfaced so
 *                        the report shape is stable when a tax slice later lands).
 *   posTaxableGrossCents — Σ line_total_cents of FINALIZED counter-sale (POS)
 *                        lines in the window (the base that WOULD be taxed).
 *
 * A "POS line" is a finalized invoice_line_item whose `description` matches a
 * product_catalog item name in the same org — the exact same POS definition
 * used by get-items-sold-report.ts (counter-sale.ts snapshots the catalog name;
 * there is intentionally no FK). Flight/dispatch/rate lines are NOT POS and are
 * excluded. The UI section subtitle MUST say tax is not yet modeled.
 *
 * ── METRIC DEFINITION ─────────────────────────────────────────────────────────
 *
 * Per bucket (UTC day/week per the R1.1 granularity rule):
 *   taxableGrossCents = Σ invoice_line_item.line_total_cents over POS lines whose
 *                       invoice.status='finalized' AND issued_at IN [bucket).
 *   taxCents          = 0 (documented — see SCOPE above).
 *
 * AUTHZ: requireCapability('billing:access') FIRST — MONEY data.
 * TENANT ISOLATION: org_id from session only; all tables RLS-scoped by the GUC.
 * READ-ONLY: zero writes. MONEY: integer cents throughout; NO float.
 *
 * [VERIFY-P2-A] NO tax determination is made here — this reports a documented
 *   zero over the POS base. NOT a tax filing or remittance statement.
 *
 * TWO CALLING FORMS:
 *   getTaxesOwedReport(session, input)          — app code.
 *   getTaxesOwedReportWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import {
  resolveReportRange,
  chooseGranularity,
  bucketStartUtc,
  enumerateBuckets,
} from '../reporting/internal.js';
import type { ReportRangeKey, BucketGranularity } from '../reporting/internal.js';
import { extractRows } from '../db-rows.js';

// ─── Input validation ─────────────────────────────────────────────────────────

const ReportRangeKeySchema = z.enum(['7d', '30d', '90d', '180d', '365d']).default('30d');
const InputSchema = z.object({ range: ReportRangeKeySchema });

export type GetTaxesOwedReportInput = { range?: ReportRangeKey | string };

// ─── Output types ─────────────────────────────────────────────────────────────

export interface TaxesOwedReportBucket {
  bucketStart: Date;
  /** Σ POS line_total_cents finalized in this bucket (the taxable base). Integer cents. */
  taxableGrossCents: number;
  /** ALWAYS 0 — the schema models no tax (see module SCOPE). Integer cents. */
  taxCents: number;
}

export interface TaxesOwedReportResult {
  range: { key: ReportRangeKey; from: Date; to: Date };
  granularity: BucketGranularity;
  buckets: TaxesOwedReportBucket[];
  /** Σ taxableGrossCents across every bucket. Integer cents. */
  totalTaxableGrossCents: number;
  /** ALWAYS 0 — documented (see module SCOPE). Integer cents. */
  totalTaxCents: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetTaxesOwedReportInput,
): Promise<TaxesOwedReportResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:access');

  // 2. Validate range.
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(`Invalid range: ${parsed.error.message}`);
  const rangeKey = parsed.data.range as ReportRangeKey;

  // 3. Resolve window + granularity.
  const now = new Date();
  const { from, to } = resolveReportRange(rangeKey, now);
  const granularity: BucketGranularity = chooseGranularity(rangeKey);
  const unit = granularity === 'day' ? 'day' : 'week';
  // from/to bound as ISO strings with ::timestamptz (postgres-js can't take a Date).

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Σ POS line totals bucketed by the invoice's issued_at. A POS line is a
    // finalized invoice_line_item whose description matches a product_catalog
    // name (same POS definition as get-items-sold-report). RLS scopes every
    // table to this org — no org_id predicate needed.
    const result = await tx.execute(sql`
      SELECT
        date_trunc(${unit}, inv.issued_at AT TIME ZONE 'UTC') AS "bucketStart",
        COALESCE(SUM(li.line_total_cents), 0)::bigint         AS "taxableGrossCents"
      FROM invoice_line_item li
      JOIN invoice inv ON inv.id = li.invoice_id
      WHERE inv.status = 'finalized'
        AND inv.issued_at >= ${from.toISOString()}::timestamptz
        AND inv.issued_at <  ${to.toISOString()}::timestamptz
        AND EXISTS (
          SELECT 1 FROM product_catalog pc WHERE pc.name = li.description
        )
      GROUP BY 1
      ORDER BY 1
    `);

    const rawRows = extractRows<{
      bucketStart: Date | string;
      taxableGrossCents: number | string;
    }>(result);

    const grossMap = new Map<string, number>();
    for (const row of rawRows) {
      const bs = bucketStartUtc(
        row.bucketStart instanceof Date ? row.bucketStart : new Date(row.bucketStart),
        granularity,
      );
      grossMap.set(bs.toISOString(), Number(row.taxableGrossCents ?? 0));
    }

    // Zero-fill: every bucket in [from, to) appears even if no DB row.
    const allBuckets = enumerateBuckets(from, to, granularity);
    let totalTaxableGrossCents = 0;

    const buckets: TaxesOwedReportBucket[] = allBuckets.map((bs) => {
      const taxableGrossCents = grossMap.get(bs.toISOString()) ?? 0;
      totalTaxableGrossCents += taxableGrossCents;
      return { bucketStart: bs, taxableGrossCents, taxCents: 0 };
    });

    return {
      range: { key: rangeKey, from, to },
      granularity,
      buckets,
      totalTaxableGrossCents,
      totalTaxCents: 0,
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getTaxesOwedReport(
  session: AppSession | null | undefined,
  rawInput: GetTaxesOwedReportInput = {},
): Promise<TaxesOwedReportResult> {
  const db = await getDb();
  return _impl(db, session, rawInput);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getTaxesOwedReportWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetTaxesOwedReportInput = {},
): Promise<TaxesOwedReportResult> {
  return _impl(db, session, rawInput);
}
