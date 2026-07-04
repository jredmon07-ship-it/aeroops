/**
 * billing/get-revenue-report.ts — getRevenueReport (Financial/AR reporting slice).
 *
 * Finalized-invoice totals + collected-payment totals over a rolling UTC
 * range, with a per-period (day/week per the existing R1.1 granularity rule)
 * breakdown. READ-ONLY aggregate over EXISTING billing tables (invoice,
 * ledger_entry) — NO new migration, NO schema change.
 *
 * ── METRIC DEFINITION (pin here — two people must compute the same number) ──
 *
 * finalizedCents (per bucket) =
 *   Σ invoice.total_cents WHERE invoice.status = 'finalized'
 *     AND invoice.issued_at IN [bucketStart, bucketEnd)   (half-open)
 *   "Revenue billed" — invoiced amount recognized at the moment it was
 *   finalized (issued_at is required + immutable once finalized: see
 *   invoice_finalized_shape_check). Void invoices are EXCLUDED (they were
 *   never collectible). Draft invoices are EXCLUDED (not yet billed).
 *
 * collectedCents (per bucket) =
 *   Σ ledger_entry.amount_cents WHERE entry_type = 'payment'
 *     AND direction = 'credit' AND ledger_entry.created_at IN [bucketStart, bucketEnd)
 *   "Cash collected" — every 'payment' credit posted in the bucket, whether a
 *   manual operator entry (recordManualPayment) or (Slice B3) a verified
 *   Stripe webhook. NOT tied to which invoice(s) it pays down (this system
 *   has no per-invoice payment allocation — see [VERIFY-AR-AGING-1] in
 *   billing/ar-aging.ts for the same caveat applied to AR aging).
 *
 * finalizedCents and collectedCents are INDEPENDENT sums — a payment
 * collected in one bucket may pay down an invoice finalized in an earlier
 * (or later) bucket. This report does NOT attempt to match them; it reports
 * "billed" and "collected" as two separate cash-basis-adjacent activity
 * series over the same UTC timeline, mirroring how an operator's bank
 * deposits vs invoice register would be read side-by-side.
 *
 * Range/bucketing: identical rule to R1.1 (reporting/internal.ts, UNCHANGED,
 * imported not modified): 7d/30d/90d/180d/365d rolling UTC window; day
 * granularity for 7d/30d, week (UTC Monday 00:00) for 90d/180d/365d;
 * zero-filled buckets.
 *
 * AUTHZ: requireCapability('billing:access') FIRST — NOT reporting:access
 *   (this is MONEY data; billing:access is owner/manager/accountant only).
 * TENANT ISOLATION: org_id from session only (withSessionOrgContextWithDb);
 *   invoice + ledger_entry are RLS-scoped by the GUC — no additional org_id
 *   predicate needed (house convention, see get-hours-by-tail.ts).
 * READ-ONLY: zero writes, zero audit rows.
 * MONEY: integer cents throughout; NO float in the money path.
 *
 * [VERIFY] This is OPERATIONAL revenue reporting, NOT a GAAP/accrual
 * statement, NOT a tax filing, NOT an audited financial statement.
 *
 * TWO CALLING FORMS:
 *   getRevenueReport(session, input)          — app code.
 *   getRevenueReportWithDb(db, session, input) — tests.
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

export type GetRevenueReportInput = { range?: ReportRangeKey | string };

// ─── Output types ─────────────────────────────────────────────────────────────

export interface RevenueReportBucket {
  bucketStart: Date;
  /** Σ invoice.total_cents for invoices finalized in this bucket. Integer cents. */
  finalizedCents: number;
  /** Σ ledger_entry 'payment' credits posted in this bucket. Integer cents. */
  collectedCents: number;
}

export interface RevenueReportResult {
  range: { key: ReportRangeKey; from: Date; to: Date };
  granularity: BucketGranularity;
  buckets: RevenueReportBucket[];
  /** Σ finalizedCents across every bucket in range. Integer cents. */
  totalFinalizedCents: number;
  /** Σ collectedCents across every bucket in range. Integer cents. */
  totalCollectedCents: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetRevenueReportInput,
): Promise<RevenueReportResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:access');

  // 2. Validate range.
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(`Invalid range: ${parsed.error.message}`);
  const rangeKey = parsed.data.range as ReportRangeKey;

  // 3. Resolve window + granularity.
  const now = new Date();
  const { from, to } = resolveReportRange(rangeKey, now);
  // In raw sql`` templates, from/to are bound as ISO strings with an explicit
  // ::timestamptz cast: the postgres-js (production) driver cannot serialize a
  // JS Date passed to db.execute() (ERR_INVALID_ARG_TYPE at the wire encoder),
  // while PGlite (tests + local demo) can — so tests never catch a raw Date.
  const granularity: BucketGranularity = chooseGranularity(rangeKey);
  const unit = granularity === 'day' ? 'day' : 'week';

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Query 1: finalized-invoice totals, bucketed by issued_at.
    // RLS scopes `invoice` to this org — no org_id predicate needed.
    const finalizedResult = await tx.execute(sql`
      SELECT
        date_trunc(${unit}, issued_at AT TIME ZONE 'UTC') AS "bucketStart",
        COALESCE(SUM(total_cents), 0)::bigint             AS "finalizedCents"
      FROM invoice
      WHERE status = 'finalized'
        AND issued_at >= ${from.toISOString()}::timestamptz
        AND issued_at < ${to.toISOString()}::timestamptz
      GROUP BY 1
      ORDER BY 1
    `);
    const finalizedRows = extractRows<{
      bucketStart: Date | string;
      finalizedCents: number | string;
    }>(finalizedResult);

    // Query 2: collected-payment totals, bucketed by created_at.
    // RLS scopes `ledger_entry` to this org — no org_id predicate needed.
    const collectedResult = await tx.execute(sql`
      SELECT
        date_trunc(${unit}, created_at AT TIME ZONE 'UTC') AS "bucketStart",
        COALESCE(SUM(amount_cents), 0)::bigint              AS "collectedCents"
      FROM ledger_entry
      WHERE entry_type = 'payment'
        AND direction = 'credit'
        AND created_at >= ${from.toISOString()}::timestamptz
        AND created_at < ${to.toISOString()}::timestamptz
      GROUP BY 1
      ORDER BY 1
    `);
    const collectedRows = extractRows<{
      bucketStart: Date | string;
      collectedCents: number | string;
    }>(collectedResult);

    // Merge both series by UTC-aligned bucket key.
    const finalizedMap = new Map<string, number>();
    for (const row of finalizedRows) {
      const bs = bucketStartUtc(
        row.bucketStart instanceof Date ? row.bucketStart : new Date(row.bucketStart),
        granularity,
      );
      finalizedMap.set(bs.toISOString(), Number(row.finalizedCents ?? 0));
    }
    const collectedMap = new Map<string, number>();
    for (const row of collectedRows) {
      const bs = bucketStartUtc(
        row.bucketStart instanceof Date ? row.bucketStart : new Date(row.bucketStart),
        granularity,
      );
      collectedMap.set(bs.toISOString(), Number(row.collectedCents ?? 0));
    }

    // Zero-fill: every bucket in [from, to) appears even if no DB row.
    const allBuckets = enumerateBuckets(from, to, granularity);
    let totalFinalizedCents = 0;
    let totalCollectedCents = 0;

    const buckets: RevenueReportBucket[] = allBuckets.map((bs) => {
      const key = bs.toISOString();
      const finalizedCents = finalizedMap.get(key) ?? 0;
      const collectedCents = collectedMap.get(key) ?? 0;
      totalFinalizedCents += finalizedCents;
      totalCollectedCents += collectedCents;
      return { bucketStart: bs, finalizedCents, collectedCents };
    });

    return {
      range: { key: rangeKey, from, to },
      granularity,
      buckets,
      totalFinalizedCents,
      totalCollectedCents,
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getRevenueReport(
  session: AppSession | null | undefined,
  rawInput: GetRevenueReportInput = {},
): Promise<RevenueReportResult> {
  const db = await getDb();
  return _impl(db, session, rawInput);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getRevenueReportWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: GetRevenueReportInput = {},
): Promise<RevenueReportResult> {
  return _impl(db, session, rawInput);
}
