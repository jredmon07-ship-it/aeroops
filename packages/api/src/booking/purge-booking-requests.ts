/**
 * purge-booking-requests.ts — Booking-request PII purge command (Slice PB-LR.A).
 *
 * Hard-deletes expired booking_request rows for the caller's org, per the
 * retention config stored in dispatch_config. Dry-run is the safe default.
 *
 * FUNCTIONS:
 *   purgeExpiredBookingRequests      — org:manage_settings → PurgeResult (uses getDb()).
 *   purgeExpiredBookingRequestsWithDb — test form; inject a pglite client.
 *   purgeExpiredBookingRequestsForOrg — internal helper; wraps withOrgContext
 *                                        (used by the devops CLI script, one org at a time).
 *
 * GUARANTEES:
 *   - requireCapability(session, 'org:manage_settings') FIRST (session form only).
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - retentionDays === 0 → {ok:true, dryRun, eligibleCount:0, deletedCount:0,
 *       retentionDisabled:true} — NO delete, NO audit. (0 = keep-forever.)
 *   - cutoff = DB clock: now() - make_interval(days => $days).
 *   - eligible = created_at < cutoff AND status IN ('new','contacted','declined')
 *     [+ 'converted' iff includesConverted].
 *   - DRY-RUN (dryRun=true, the default):
 *       SELECT count(*) only — no delete, NO audit row.
 *   - APPLY (dryRun=false):
 *       DELETE ... RETURNING id → deletedCount;
 *       ONE audit_log row 'booking_request.purged'
 *         { deletedCount, retentionDays, includesConverted, cutoffIso } — COUNTS ONLY.
 *       NEVER logs requester PII (the point is the PII is gone).
 *   - org_id NOT in the WHERE clause — RLS DELETE policy is the structural backstop.
 *   - Hard-DELETE (not anonymize).
 *   - Purge touches ONLY booking_request; audit_log rows are append-only (never purged).
 *
 * [VERIFY-PB1-COMP-1]: Compliance to confirm hard-delete-vs-anonymize posture,
 * 365-day default acceptability, and whether status-change audit rows (status+id,
 * no PII) may be retained post-purge.
 *
 * TWO CALLING FORMS per function:
 *   fn(session, input)         — app code (uses getDb() internally).
 *   fnWithDb(db, session, in)  — tests (inject pglite client).
 */

import { sql } from 'drizzle-orm';
import { dispatchConfig, auditLog } from '@aeroops/db';
import { withOrgContext } from '@aeroops/db';
import { eq } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * PurgeExpiredBookingRequestsInput — optional options for purge command.
 *
 * dryRun (default true): when true, SELECT count only — no delete, no audit.
 *   ALWAYS default to dry-run: the caller must explicitly pass dryRun:false to delete.
 */
export interface PurgeExpiredBookingRequestsInput {
  /** Default true. Dry-run counts eligible rows without deleting. */
  dryRun?: boolean;
}

/**
 * PurgeExpiredBookingRequestsResult — tagged result of the purge command.
 *
 * retentionDisabled: true when retentionDays === 0 (keep-forever). When true,
 *   eligibleCount and deletedCount are both 0 and no delete occurred.
 */
export type PurgeExpiredBookingRequestsResult = {
  ok: true;
  dryRun: boolean;
  eligibleCount: number;
  deletedCount: number;
  retentionDisabled: boolean;
};

// ─── Internal helper: load retention config ───────────────────────────────────

/** Defaults when no dispatch_config row exists for the org. */
interface RetentionConfig {
  retentionDays: number;
  includesConverted: boolean;
}

async function loadRetentionConfig(
  tx: AnyDb,
  orgId: string,
): Promise<RetentionConfig> {
  const rows = await tx
    .select({
      bookingRequestRetentionDays:              dispatchConfig.bookingRequestRetentionDays,
      bookingRequestRetentionIncludesConverted: dispatchConfig.bookingRequestRetentionIncludesConverted,
    })
    .from(dispatchConfig)
    .where(eq(dispatchConfig.orgId, orgId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return { retentionDays: 365, includesConverted: false };
  }

  return {
    retentionDays:     row.bookingRequestRetentionDays,
    includesConverted: row.bookingRequestRetentionIncludesConverted,
  };
}

// ─── purgeExpiredBookingRequestsForOrg ───────────────────────────────────────

/**
 * purgeExpiredBookingRequestsForOrg — internal helper used by the devops CLI script.
 *
 * Wraps withOrgContext(db, orgId) — the org context sets the RLS GUC so the
 * DELETE policy (booking_request_delete USING org_id=current_org_id) is the
 * structural backstop. org_id is NOT in the WHERE clause on purpose.
 *
 * Suitable for one-org-at-a-time iteration in the script; the script is
 * responsible for enumerating org IDs via a platform read and calling this
 * for each one.
 *
 * @param db       — Drizzle client (or pglite test client).
 * @param orgId    — UUID of the org to purge.
 * @param dryRun   — when true (default), count only; no delete, no audit.
 * @returns        — PurgeExpiredBookingRequestsResult.
 */
export async function purgeExpiredBookingRequestsForOrg(
  db: AnyDb,
  orgId: string,
  opts: { dryRun?: boolean } = {},
): Promise<PurgeExpiredBookingRequestsResult> {
  const dryRun = opts.dryRun !== false; // default true

  return withOrgContext(db, orgId, async (tx) => {
    // 1. Load retention config (defaults when absent).
    const { retentionDays, includesConverted } = await loadRetentionConfig(tx, orgId);

    // 2. days=0 → keep-forever; no-op with retentionDisabled:true.
    if (retentionDays === 0) {
      return {
        ok:                true,
        dryRun,
        eligibleCount:     0,
        deletedCount:      0,
        retentionDisabled: true,
      } as const;
    }

    // 3. Build the status IN clause.
    //    Base statuses: new, contacted, declined.
    //    Converted added only when includesConverted is true.
    const statusList = includesConverted
      ? sql`('new', 'contacted', 'declined', 'converted')`
      : sql`('new', 'contacted', 'declined')`;

    if (dryRun) {
      // 4a. DRY-RUN: count eligible rows only. No delete, no audit.
      const countResult = await tx.execute(sql`
        SELECT COUNT(*)::bigint AS eligible_count
        FROM booking_request
        WHERE created_at < now() - make_interval(days => ${retentionDays})
          AND status IN ${statusList}
      `);
      const rows = countResult.rows as Array<{ eligible_count: string }>;
      const eligibleCount = Number(rows[0]?.eligible_count ?? 0);

      return {
        ok:                true,
        dryRun:            true,
        eligibleCount,
        deletedCount:      0,
        retentionDisabled: false,
      } as const;
    }

    // 4b. APPLY: DELETE RETURNING id → count deleted rows.
    //     org_id is NOT in the WHERE — RLS DELETE policy is the backstop.
    const deleteResult = await tx.execute(sql`
      DELETE FROM booking_request
      WHERE created_at < now() - make_interval(days => ${retentionDays})
        AND status IN ${statusList}
      RETURNING id
    `);
    const deletedRows = deleteResult.rows as Array<{ id: string }>;
    const deletedCount = deletedRows.length;

    // 5. Compute cutoff ISO timestamp from DB clock for the audit row.
    const cutoffResult = await tx.execute(sql`
      SELECT (now() - make_interval(days => ${retentionDays}))::text AS cutoff_iso
    `);
    const cutoffRows = cutoffResult.rows as Array<{ cutoff_iso: string }>;
    const cutoffIso = cutoffRows[0]?.cutoff_iso ?? new Date().toISOString();

    // 6. ONE audit_log row — COUNTS ONLY, never requester PII.
    //    entity_id is null (no single row; this is a bulk operation).
    await tx.insert(auditLog).values({
      orgId,
      actorUserId: null,
      action:      'booking_request.purged',
      entityType:  'booking_request',
      entityId:    null,
      metadata: {
        deletedCount,
        retentionDays,
        includesConverted,
        cutoffIso,
      },
    });

    return {
      ok:                true,
      dryRun:            false,
      eligibleCount:     deletedCount,
      deletedCount,
      retentionDisabled: false,
    } as const;
  });
}

// ─── _purgeExpiredBookingRequestsImpl ────────────────────────────────────────

async function _purgeExpiredBookingRequestsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<PurgeExpiredBookingRequestsResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'org:manage_settings');

  // 2. Parse dryRun option (defaults to true when absent).
  const input = rawInput as PurgeExpiredBookingRequestsInput | undefined;
  const dryRun = input?.dryRun !== false;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load retention config (defaults when absent).
    const { retentionDays, includesConverted } = await loadRetentionConfig(tx, sess.orgId);

    // 4. days=0 → keep-forever; no-op with retentionDisabled:true.
    if (retentionDays === 0) {
      return {
        ok:                true,
        dryRun,
        eligibleCount:     0,
        deletedCount:      0,
        retentionDisabled: true,
      } as const;
    }

    // 5. Build the status IN clause.
    const statusList = includesConverted
      ? sql`('new', 'contacted', 'declined', 'converted')`
      : sql`('new', 'contacted', 'declined')`;

    if (dryRun) {
      // 6a. DRY-RUN: count eligible rows only. No delete, no audit.
      const countResult = await tx.execute(sql`
        SELECT COUNT(*)::bigint AS eligible_count
        FROM booking_request
        WHERE created_at < now() - make_interval(days => ${retentionDays})
          AND status IN ${statusList}
      `);
      const rows = countResult.rows as Array<{ eligible_count: string }>;
      const eligibleCount = Number(rows[0]?.eligible_count ?? 0);

      return {
        ok:                true,
        dryRun:            true,
        eligibleCount,
        deletedCount:      0,
        retentionDisabled: false,
      } as const;
    }

    // 6b. APPLY: DELETE RETURNING id.
    //     org_id is NOT in the WHERE — RLS DELETE policy is the backstop.
    const deleteResult = await tx.execute(sql`
      DELETE FROM booking_request
      WHERE created_at < now() - make_interval(days => ${retentionDays})
        AND status IN ${statusList}
      RETURNING id
    `);
    const deletedRows = deleteResult.rows as Array<{ id: string }>;
    const deletedCount = deletedRows.length;

    // 7. Compute cutoff ISO timestamp from DB clock.
    const cutoffResult = await tx.execute(sql`
      SELECT (now() - make_interval(days => ${retentionDays}))::text AS cutoff_iso
    `);
    const cutoffRows = cutoffResult.rows as Array<{ cutoff_iso: string }>;
    const cutoffIso = cutoffRows[0]?.cutoff_iso ?? new Date().toISOString();

    // 8. ONE audit_log row — COUNTS ONLY, NEVER requester PII.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'booking_request.purged',
      entityType:  'booking_request',
      entityId:    null,
      metadata: {
        deletedCount,
        retentionDays,
        includesConverted,
        cutoffIso,
      },
    });

    return {
      ok:                true,
      dryRun:            false,
      eligibleCount:     deletedCount,
      deletedCount,
      retentionDisabled: false,
    } as const;
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * purgeExpiredBookingRequests — hard-delete expired booking_request rows for the session org.
 *
 * Dry-run is the DEFAULT (safe). Pass { dryRun: false } to actually delete.
 *
 * @param session  — AppSession; null/undefined → UnauthenticatedError.
 * @param rawInput — { dryRun?: boolean }. Defaults to { dryRun: true }.
 * @returns        — { ok:true, dryRun, eligibleCount, deletedCount, retentionDisabled }.
 * @throws         — UnauthenticatedError | ForbiddenError.
 */
export async function purgeExpiredBookingRequests(
  session: AppSession | null | undefined,
  rawInput: unknown = {},
): Promise<PurgeExpiredBookingRequestsResult> {
  const db = await getDb();
  return _purgeExpiredBookingRequestsImpl(db, session, rawInput);
}

/** purgeExpiredBookingRequestsWithDb — test form; inject a pglite client. */
export async function purgeExpiredBookingRequestsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown = {},
): Promise<PurgeExpiredBookingRequestsResult> {
  return _purgeExpiredBookingRequestsImpl(db, session, rawInput);
}
