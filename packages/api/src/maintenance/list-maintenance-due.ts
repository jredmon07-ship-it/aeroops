/**
 * list-maintenance-due.ts — listMaintenanceDue + getMaintenanceDueSummary
 * read paths (Slice P1.5).
 *
 * listMaintenanceDue — active maintenance_item rows joined with each
 *   aircraft's LAST-RECORDED meters (DISPLAY-ONLY read via
 *   fleet/internal.ts loadCurrentMetersBatch — never recomputed, never
 *   touches the dispatch meter WRITE paths), run through @aeroops/core's
 *   pure evaluateMaintenanceDue, sorted overdue → due_soon → unknown → ok
 *   (title ASC as a stable tiebreak within each bucket).
 *
 * getMaintenanceDueSummary — point-in-time overdue/due_soon/ok/unknown
 *   counts across the whole org (dashboard tile).
 *
 * GUARANTEES (both):
 *   - requireCapability('maintenance:access') FIRST.
 *   - org_id from session only; RLS-scoped throughout.
 *   - No N+1: ONE query for items + ONE batched meter query.
 *   - NO computed FAA/Part-43/91.409 determination — evaluateMaintenanceDue
 *     is pure arithmetic on operator-entered thresholds. [VERIFY-P1.5-A]
 *
 * TWO CALLING FORMS per function (app + WithDb).
 */
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { maintenanceItem } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { evaluateMaintenanceDue } from '@aeroops/core';
import type { MaintenanceDueStatus } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toMaintenanceItemView } from './internal.js';
import { loadCurrentMetersBatch } from '../fleet/internal.js';
import type { MaintenanceDueView, MaintenanceDueSummary } from './maintenance-item-types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Reference day ────────────────────────────────────────────────────────────

/**
 * The caller's calendar day, 'YYYY-MM-DD' — the viewer's "today" in their own
 * zone. Date items are due/overdue against the day the viewer is on, not the
 * server's UTC day (at 19:00 CST the UTC date is already tomorrow). Optional:
 * absent → the server's current UTC date (cron/email paths). Display-only
 * arithmetic, never persisted. [VERIFY-P1.5-A]
 */
export const maintenanceTodaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'today must be YYYY-MM-DD' })
  .refine(
    (s) => {
      // Round-trip: Date.parse rolls 2026-02-30 over to March instead of failing.
      const ms = Date.parse(`${s}T00:00:00Z`);
      return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s;
    },
    { message: 'today must be a real date' },
  );

/**
 * referenceDate — the instant evaluateMaintenanceDue reads `today` from. It
 * uses only the UTC calendar fields, so a 'YYYY-MM-DD' day becomes that day's
 * UTC midnight; no day → now.
 */
function referenceDate(today: string | undefined): Date {
  return today === undefined ? new Date() : new Date(`${today}T00:00:00Z`);
}

// Sort bucket: overdue first, then due_soon, then unknown (can't evaluate —
// surfaced ahead of 'ok' so an operator notices a never-recorded meter),
// then ok last.
const STATUS_SORT_RANK: Record<MaintenanceDueStatus, number> = {
  overdue: 0,
  due_soon: 1,
  unknown: 2,
  ok: 3,
};

// ─── Shared: load + evaluate all active items (optionally scoped to one resource) ─
//
// Exported (not re-exported from @aeroops/api's index) so notify-maintenance-
// due.ts can reuse the exact same load+evaluate logic inside its OWN
// requireCapability + withSessionOrgContextWithDb call, without a second
// authz check or a duplicated query. Callers of this function are
// responsible for their own authz + context — it does neither itself
// (mirrors loadGroundingProbe's tx-level-helper contract).

export async function loadMaintenanceDueViews(
  tx: AnyDb,
  resourceId: string | undefined,
  /** The viewer's calendar day 'YYYY-MM-DD' (maintenanceTodaySchema); absent → now. */
  today?: string,
): Promise<MaintenanceDueView[]> {
  const conditions = [eq(maintenanceItem.active, true)];
  if (resourceId !== undefined) {
    conditions.push(eq(maintenanceItem.resourceId, resourceId));
  }

  const itemRows = await tx
    .select()
    .from(maintenanceItem)
    .where(and(...conditions));

  if (itemRows.length === 0) return [];

  const resourceIds = [...new Set(itemRows.map((r) => r.resourceId))];
  const metersMap = await loadCurrentMetersBatch(tx, resourceIds);

  const reference = referenceDate(today);

  const views: MaintenanceDueView[] = itemRows.map((row) => {
    const itemView = toMaintenanceItemView(row);
    const meters = metersMap.get(row.resourceId) ?? {
      currentHobbs: null,
      currentTach: null,
      currentMetersAsOf: null,
    };
    const evaluation = evaluateMaintenanceDue(
      {
        trackBy: itemView.trackBy,
        meterBasis: itemView.meterBasis,
        dueValueHours: itemView.dueValueHours,
        dueDate: itemView.dueDate,
        warnThresholdHours: itemView.warnThresholdHours,
        warnLeadDays: itemView.warnLeadDays,
      },
      { hobbs: meters.currentHobbs, tach: meters.currentTach },
      reference,
    );

    return {
      ...itemView,
      status: evaluation.status,
      remainingHours: evaluation.remainingHours,
      remainingDays: evaluation.remainingDays,
      currentHobbs: meters.currentHobbs,
      currentTach: meters.currentTach,
    };
  });

  views.sort((a, b) => {
    const rankDiff = STATUS_SORT_RANK[a.status] - STATUS_SORT_RANK[b.status];
    if (rankDiff !== 0) return rankDiff;
    return a.title.localeCompare(b.title);
  });

  return views;
}

// ─── listMaintenanceDue ────────────────────────────────────────────────────────

const listMaintenanceDueInputSchema = z.object({
  resourceId: z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }).optional(),
  today: maintenanceTodaySchema.optional(),
});

export type ListMaintenanceDueInput = z.infer<typeof listMaintenanceDueInputSchema>;

async function _listMaintenanceDueImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<MaintenanceDueView[]> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'maintenance:access');

  // 2. VALIDATE.
  const parsed = listMaintenanceDueInputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid listMaintenanceDue input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceId, today } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) =>
    loadMaintenanceDueViews(tx, resourceId, today),
  );
}

export async function listMaintenanceDue(
  session: AppSession | null | undefined,
  input: unknown = {},
): Promise<MaintenanceDueView[]> {
  const db = await getDb();
  return _listMaintenanceDueImpl(db, session, input);
}

export async function listMaintenanceDueWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown = {},
): Promise<MaintenanceDueView[]> {
  return _listMaintenanceDueImpl(db, session, input);
}

// ─── getMaintenanceDueSummary ───────────────────────────────────────────────────

const getMaintenanceDueSummaryInputSchema = z.object({
  today: maintenanceTodaySchema.optional(),
});

export type GetMaintenanceDueSummaryInput = z.infer<typeof getMaintenanceDueSummaryInputSchema>;

async function _getMaintenanceDueSummaryImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<MaintenanceDueSummary> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'maintenance:access');

  // 2. VALIDATE.
  const parsed = getMaintenanceDueSummaryInputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid getMaintenanceDueSummary input: ${first?.message ?? 'unknown'}`,
    );
  }

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const views = await loadMaintenanceDueViews(tx, undefined, parsed.data.today);
    const summary: MaintenanceDueSummary = {
      overdueCount: 0,
      dueSoonCount: 0,
      okCount: 0,
      unknownCount: 0,
    };
    for (const v of views) {
      if (v.status === 'overdue') summary.overdueCount++;
      else if (v.status === 'due_soon') summary.dueSoonCount++;
      else if (v.status === 'ok') summary.okCount++;
      else summary.unknownCount++;
    }
    return summary;
  });
}

export async function getMaintenanceDueSummary(
  session: AppSession | null | undefined,
  input: unknown = {},
): Promise<MaintenanceDueSummary> {
  const db = await getDb();
  return _getMaintenanceDueSummaryImpl(db, session, input);
}

export async function getMaintenanceDueSummaryWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown = {},
): Promise<MaintenanceDueSummary> {
  return _getMaintenanceDueSummaryImpl(db, session, input);
}
