/**
 * billing/generate-dues-invoices.ts — generateDuesInvoices (Slice P0-REV, C6).
 *
 * Creates one DRAFT invoice per active dues_schedule per calendar period.
 * IDEMPOTENT per (schedule, period) via dues_run's UNIQUE (org_id,
 * dues_schedule_id, period_key) — SAFE TO CALL REPEATEDLY: running twice in
 * the same period produces ZERO new invoices on the second call.
 *
 * ORDERING (per schedule, inside ONE SAVEPOINT):
 *   1. INSERT the DRAFT invoice + its one line item (tentative).
 *   2. INSERT INTO dues_run (...) ON CONFLICT (org_id, dues_schedule_id,
 *      period_key) DO NOTHING RETURNING id — THE idempotency mechanism.
 *   3. No row returned ⇒ this (schedule, period) was already run (by this
 *      call or a concurrent one) ⇒ throw a sentinel error, which propagates
 *      out of the savepoint callback and causes Drizzle to emit ROLLBACK TO
 *      SAVEPOINT — discarding the tentative invoice + line item. We catch
 *      the sentinel outside the savepoint and record a skip. The dues_run
 *      table therefore NEVER carries a NULL invoice_id (it is always set at
 *      INSERT, immutable) — dues_run's UNIQUE constraint on the ORIGINAL
 *      attempt (not this one) is what "already ran" means.
 *   4. Row returned ⇒ this call is the sole winner for this period; the
 *      savepoint commits, and we record a create.
 *
 * A SAVEPOINT-per-schedule means one schedule's failure (e.g. an unexpected
 * error) does not abort the whole batch — the outer tx (and every other
 * schedule's already-committed savepoint) stays alive.
 *
 * NO CHARGE happens here — only a DRAFT invoice is created. Finalizing that
 * invoice (a separate staff action) flows into the UNCHANGED auto-pay path
 * (migration 0024 / autopay.ts) if the member has autopay configured.
 *
 * GUARANTEES:
 *   - authz FIRST: billing:manage before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - INTEGER CENTS only: subtotal_cents === total_cents === line_total_cents
 *     === dues_schedule.amount_cents, no float math.
 *   - Audited: ONE summary row 'billing.dues_generated' (counts + periodKey;
 *     no dollar totals beyond per-invoice, which is fine — integer cents).
 *
 * TWO CALLING FORMS:
 *   generateDuesInvoices(session, input)          — app code.
 *   generateDuesInvoicesWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { duesRun, invoice, invoiceLineItem, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { isDuesScheduleDue, isDuesCadence } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { loadActiveDuesSchedules } from './dues-internal.js';

const PERIOD_KEY_RE = /^\d{4}-\d{2}$/;

const generateDuesInvoicesInputSchema = z.object({
  periodKey: z.string().regex(PERIOD_KEY_RE, { message: 'periodKey must be "YYYY-MM"' }),
});

export type GenerateDuesInvoicesInput = z.infer<typeof generateDuesInvoicesInputSchema>;

export interface GenerateDuesInvoicesCreated {
  scheduleId: string;
  invoiceId: string;
  /**
   * Additive (Slice P1.3): the dues-payer's user id + the invoice amount,
   * so the web action layer can fire a best-effort 'dues.generated'
   * notification without needing its own DB read (apps/web never imports
   * @aeroops/db). amountCents mirrors dues_schedule.amount_cents exactly —
   * INTEGER CENTS, no float math.
   */
  userId: string;
  amountCents: number;
}

export interface GenerateDuesInvoicesSkipped {
  scheduleId: string;
  reason: 'already_run' | 'not_due_this_period';
}

export interface GenerateDuesInvoicesResult {
  created: GenerateDuesInvoicesCreated[];
  skipped: GenerateDuesInvoicesSkipped[];
}

/** Sentinel — thrown INSIDE the savepoint to force ROLLBACK TO SAVEPOINT when
 * this (schedule, period) has already been run. NEVER escapes this file. */
class DuesAlreadyRunError extends Error {
  constructor() {
    super('[billing] dues_run: this (schedule, period) was already generated');
  }
}

async function _generateDuesInvoicesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GenerateDuesInvoicesResult> {
  requireCapability(session, 'billing:manage');

  const parsed = generateDuesInvoicesInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[billing] invalid generateDuesInvoices input: ${first?.message ?? 'unknown'}`);
  }
  const { periodKey } = parsed.data;

  // The calendar month (1–12) this run bills for, parsed from "YYYY-MM".
  const runMonth = Number(periodKey.slice(5, 7));

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // Graceful-absence loader: pre-0050 every schedule reads as monthly (anchor
    // null), so the cadence gate below is a no-op and behavior is unchanged.
    const schedules = await loadActiveDuesSchedules(tx, sess.orgId);

    const created: GenerateDuesInvoicesCreated[] = [];
    const skipped: GenerateDuesInvoicesSkipped[] = [];

    for (const schedule of schedules) {
      // Cadence gate: only bill a schedule in a month it is actually due.
      // Monthly is always due, so monthly schedules are byte-identical to the
      // pre-cadence engine. An unrecognized cadence is treated as monthly
      // (fail-safe toward the prior behavior).
      const cadence = isDuesCadence(schedule.cadence) ? schedule.cadence : 'monthly';
      if (!isDuesScheduleDue(cadence, schedule.anchorMonth, runMonth)) {
        skipped.push({ scheduleId: schedule.id, reason: 'not_due_this_period' });
        continue;
      }
      try {
        const createdInvoiceId = await (tx as AnyDb).transaction(async (sp: AnyDb) => {
          // 1. INSERT the DRAFT invoice — INTEGER CENTS, no float math.
          const invoiceInserted = await sp
            .insert(invoice)
            .values({
              orgId: sess.orgId,
              memberUserId: schedule.userId,
              status: 'draft',
              subtotalCents: schedule.amountCents,
              totalCents: schedule.amountCents,
              dispatchTicketId: null,
              issuedAt: null,
              createdBy: sess.userId,
            })
            .returning();
          const invoiceRow = invoiceInserted[0];
          if (!invoiceRow) throw new Error('[billing] generateDuesInvoices: invoice INSERT returned no rows');

          await sp.insert(invoiceLineItem).values({
            orgId: sess.orgId,
            invoiceId: invoiceRow.id,
            description: schedule.memo ?? 'Membership dues',
            quantityHours: '1.0',
            unitAmountCents: schedule.amountCents,
            lineTotalCents: schedule.amountCents,
            rateScheduleId: null,
          });

          // 2. THE IDEMPOTENCY MECHANISM: insert the marker with the
          //    invoice id already set. A conflict means "already run".
          const runInserted = await sp
            .insert(duesRun)
            .values({
              orgId: sess.orgId,
              duesScheduleId: schedule.id,
              periodKey,
              invoiceId: invoiceRow.id,
            })
            .onConflictDoNothing({
              target: [duesRun.orgId, duesRun.duesScheduleId, duesRun.periodKey],
            })
            .returning({ id: duesRun.id });

          if (!runInserted[0]) {
            // 3. Already run — force ROLLBACK TO SAVEPOINT, discarding the
            //    tentative invoice + line item above.
            throw new DuesAlreadyRunError();
          }

          // 4. Winner — savepoint commits.
          return invoiceRow.id;
        });

        created.push({
          scheduleId: schedule.id,
          invoiceId: createdInvoiceId,
          userId: schedule.userId,
          amountCents: schedule.amountCents,
        });
      } catch (err) {
        if (err instanceof DuesAlreadyRunError) {
          skipped.push({ scheduleId: schedule.id, reason: 'already_run' });
          continue;
        }
        throw err;
      }
    }

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.dues_generated',
      entityType: 'org',
      entityId: sess.orgId,
      metadata: {
        periodKey,
        createdCount: created.length,
        skippedCount: skipped.length,
        createdScheduleIds: created.map((c) => c.scheduleId),
      },
    });

    return { created, skipped };
  });
}

export async function generateDuesInvoices(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GenerateDuesInvoicesResult> {
  const db = await getDb();
  return _generateDuesInvoicesImpl(db, session, input);
}

export async function generateDuesInvoicesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GenerateDuesInvoicesResult> {
  return _generateDuesInvoicesImpl(db, session, input);
}
