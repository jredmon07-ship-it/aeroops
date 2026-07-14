/**
 * integrations/qbo/backfill.ts — backfillQboExports (QBO SYNC layer).
 *
 * "Sync everything unexported" — a bounded, sequential, best-effort catch-up
 * for an org that connected QuickBooks after already having finalized invoices
 * (or had auto-sync off for a while). NO cron: an operator triggers it from
 * the QBO settings card; it processes at most one bounded batch per call and
 * reports what is left. Covers BOTH entity kinds:
 *
 *   INVOICES — finalized invoices with no 'exported' log row.
 *   PAYMENTS — invoice-linked 'payment' ledger entries whose invoice IS
 *     exported but whose ReceivePayment is not (migration 0046 only; skipped
 *     entirely — paymentsRemaining 0 — when 0046 is unapplied, since the
 *     export-log CHECK would reject entity_type='payment'). This is also the
 *     RETRY path for a payment auto-sync that failed on the webhook.
 *
 * BEHAVIOR:
 *   1. requireCapability('billing:manage') FIRST.
 *   2. Find candidate invoices (and, when 0046 is applied, candidate
 *      payments), OLDEST-FIRST, LIMIT 50 each. Also count each full backlog.
 *   3. If the org is not connected, do nothing — return zero tallies with the
 *      full backlogs as remaining (calling the exporter 50× just to collect
 *      not_connected is pointless).
 *   4. Otherwise push each invoice through the FROZEN, idempotent
 *      exportInvoiceToQbo, then each payment through the idempotent
 *      syncPaymentToQbo (each in its own tx). Tally ok vs. refusal.
 *   5. remaining = backlog − exported (a failed candidate is still unexported).
 *   6. ONE audit row 'billing.qbo_backfill_run' with all the tallies.
 *
 * GUARANTEES:
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - BOUNDED: at most 100 provider pushes per invocation (50 + 50) — no
 *     unbounded loop.
 *   - PARTIAL-FAILURE RESILIENT: one item failing (provider_error /
 *     unmapped_kinds) never aborts the batch; it is counted as failed and the
 *     loop continues.
 *   - Invoice arm reuses only base (migration 0021) tables — prod-safe with OR
 *     without 0046; the payment arm is 0046-guarded.
 *   - NO money moves — a bulk of the same bookkeeping export the button does.
 *
 * TWO CALLING FORMS:
 *   backfillQboExports(session)          — app code.
 *   backfillQboExportsWithDb(db, session, client?) — tests (client injectable).
 */

import { sql } from 'drizzle-orm';
import { auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../../auth/session.js';
import { getDb } from '../../db.js';
import type { AppSession } from '../../auth/types.js';
import { extractRows } from '../../db-rows.js';
import { exportInvoiceToQboWithDb } from './export-invoice.js';
import { syncPaymentToQboWithDb } from './sync-payment.js';
import { qboConnectionHasAutoExportColumn } from './qbo-sync-internal.js';
import { getQboClient } from './client.js';
import type { QboClient } from './client.js';

/** The per-call batch bound — at most this many invoices (and this many payments) per invocation. */
export const QBO_BACKFILL_BATCH_LIMIT = 50;

export interface BackfillQboExportsResult {
  /** Invoices successfully exported (or already exported) this run. */
  exported: number;
  /** Invoices that hit a typed refusal this run (still unexported). */
  failed: number;
  /** Unexported finalized invoices still remaining after this run. */
  remaining: number;
  /** Invoice-linked payments successfully synced (or already synced) this run. */
  paymentsExported: number;
  /** Payments that hit a typed refusal this run (still unsynced). */
  paymentsFailed: number;
  /** Unsynced eligible payments still remaining after this run (0 when migration 0046 is unapplied). */
  paymentsRemaining: number;
}

/**
 * The FROM/WHERE body shared by the payment-candidate SELECT and COUNT:
 * invoice-linked 'payment' ledger entries whose invoice has an 'exported' log
 * row but the payment does not. orgId is interpolated as a bound parameter
 * (::uuid) — never string-concatenated.
 */
function paymentCandidateFromWhereSql(orgId: string) {
  return sql`
    FROM "ledger_entry" le
    WHERE le."org_id" = ${orgId}::uuid
      AND le."entry_type" = 'payment'
      AND le."invoice_id" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "qbo_export_log" li
        WHERE li."org_id" = le."org_id"
          AND li."entity_type" = 'invoice'
          AND li."entity_id" = le."invoice_id"
          AND li."status" = 'exported'
      )
      AND NOT EXISTS (
        SELECT 1 FROM "qbo_export_log" lp
        WHERE lp."org_id" = le."org_id"
          AND lp."entity_type" = 'payment'
          AND lp."entity_id" = le."id"
          AND lp."status" = 'exported'
      )
  `;
}

async function _backfillQboExportsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  client: QboClient = getQboClient(),
): Promise<BackfillQboExportsResult> {
  requireCapability(session, 'billing:manage');

  // 1. Read the candidate batches + the full backlog counts + connection state.
  const { candidateIds, backlog, paymentBacklog, connected } = await withSessionOrgContextWithDb(
    db,
    session,
    async (sess, tx) => {
      const candidateRows = extractRows<{ id: string }>(
        await tx.execute(sql`
          SELECT i."id"
          FROM "invoice" i
          WHERE i."org_id" = ${sess.orgId}::uuid
            AND i."status" = 'finalized'
            AND NOT EXISTS (
              SELECT 1 FROM "qbo_export_log" l
              WHERE l."org_id" = i."org_id"
                AND l."entity_type" = 'invoice'
                AND l."entity_id" = i."id"
                AND l."status" = 'exported'
            )
          ORDER BY i."created_at" ASC
          LIMIT ${QBO_BACKFILL_BATCH_LIMIT}
        `),
      );

      const countRows = extractRows<{ n: number | string }>(
        await tx.execute(sql`
          SELECT COUNT(*)::int AS n
          FROM "invoice" i
          WHERE i."org_id" = ${sess.orgId}::uuid
            AND i."status" = 'finalized'
            AND NOT EXISTS (
              SELECT 1 FROM "qbo_export_log" l
              WHERE l."org_id" = i."org_id"
                AND l."entity_type" = 'invoice'
                AND l."entity_id" = i."id"
                AND l."status" = 'exported'
            )
        `),
      );

      const connRows = extractRows<{ status: string; access_token: string | null; realm_id: string | null }>(
        await tx.execute(sql`
          SELECT "status", "access_token", "realm_id"
          FROM "qbo_connection"
          WHERE "org_id" = ${sess.orgId}::uuid
          LIMIT 1
        `),
      );
      const conn = connRows[0];
      const isConnected = Boolean(conn && conn.status === 'connected' && conn.access_token && conn.realm_id);

      // Pre-run payment backlog COUNT only (migration 0046 only — when 0046 is
      // unapplied the export-log CHECK would reject entity_type='payment', so
      // the payment arm reports zero and does nothing). Candidate ids are
      // selected LATER, after the invoice arm, so an invoice exported this run
      // gets its payment synced in the SAME press.
      let paymentCount = 0;
      if (await qboConnectionHasAutoExportColumn(tx)) {
        const paymentCountRows = extractRows<{ n: number | string }>(
          await tx.execute(sql`
            SELECT COUNT(*)::int AS n
            ${paymentCandidateFromWhereSql(sess.orgId)}
          `),
        );
        paymentCount = Number(paymentCountRows[0]?.n ?? 0);
      }

      return {
        candidateIds: candidateRows.map((r) => r.id),
        backlog: Number(countRows[0]?.n ?? 0),
        paymentBacklog: paymentCount,
        connected: isConnected,
      };
    },
  );

  // 2. Not connected → nothing to do; the whole backlog remains.
  if (!connected) {
    return {
      exported: 0,
      failed: 0,
      remaining: backlog,
      paymentsExported: 0,
      paymentsFailed: 0,
      paymentsRemaining: paymentBacklog,
    };
  }

  // 3. Sequential, partial-failure-resilient push. Each export runs in its own
  //    tx (exportInvoiceToQboWithDb opens withSessionOrgContext) — a single
  //    failure never rolls back a prior success.
  let exported = 0;
  let failed = 0;
  for (const invoiceId of candidateIds) {
    // Each item is isolated: a THROW (e.g. a lost idempotency race aborting the
    // item's own tx) counts as a failure and the batch continues — honoring the
    // "one item failing never aborts the batch" guarantee even for throws, not
    // just typed refusals.
    try {
      const result = await exportInvoiceToQboWithDb(db, session, { invoiceId }, client);
      if (result.ok) exported += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }

  const remaining = Math.max(0, backlog - exported);

  // 3b. Same sweep for eligible payments (idempotent; empty when 0046 absent).
  //     Candidates are selected NOW — after the invoice arm — so a payment
  //     whose invoice was exported just above syncs in the same press. The
  //     post-arm eligible count is also re-read here (the invoice arm can only
  //     GROW eligibility, so the pre-run paymentBacklog may undercount).
  const { paymentCandidateIds, postArmPaymentBacklog } = await withSessionOrgContextWithDb(
    db,
    session,
    async (sess, tx) => {
      if (!(await qboConnectionHasAutoExportColumn(tx))) {
        return { paymentCandidateIds: [] as string[], postArmPaymentBacklog: 0 };
      }
      const paymentRows = extractRows<{ id: string }>(
        await tx.execute(sql`
          SELECT le."id"
          ${paymentCandidateFromWhereSql(sess.orgId)}
          ORDER BY le."created_at" ASC
          LIMIT ${QBO_BACKFILL_BATCH_LIMIT}
        `),
      );
      const paymentCountRows = extractRows<{ n: number | string }>(
        await tx.execute(sql`
          SELECT COUNT(*)::int AS n
          ${paymentCandidateFromWhereSql(sess.orgId)}
        `),
      );
      return {
        paymentCandidateIds: paymentRows.map((r) => r.id),
        postArmPaymentBacklog: Number(paymentCountRows[0]?.n ?? 0),
      };
    },
  );

  let paymentsExported = 0;
  let paymentsFailed = 0;
  for (const ledgerEntryId of paymentCandidateIds) {
    try {
      const result = await syncPaymentToQboWithDb(db, session, { ledgerEntryId }, client);
      if (result.ok) paymentsExported += 1;
      else paymentsFailed += 1;
    } catch {
      paymentsFailed += 1;
    }
  }

  const paymentsRemaining = Math.max(0, postArmPaymentBacklog - paymentsExported);

  // 4. ONE audit row for the run.
  await withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.qbo_backfill_run',
      entityType: 'org',
      entityId: sess.orgId,
      metadata: {
        exported,
        failed,
        remaining,
        paymentsExported,
        paymentsFailed,
        paymentsRemaining,
        batchLimit: QBO_BACKFILL_BATCH_LIMIT,
      },
    });
  });

  return { exported, failed, remaining, paymentsExported, paymentsFailed, paymentsRemaining };
}

export async function backfillQboExports(
  session: AppSession | null | undefined,
): Promise<BackfillQboExportsResult> {
  const db = await getDb();
  return _backfillQboExportsImpl(db, session);
}

export async function backfillQboExportsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  client?: QboClient,
): Promise<BackfillQboExportsResult> {
  return _backfillQboExportsImpl(db, session, client);
}
