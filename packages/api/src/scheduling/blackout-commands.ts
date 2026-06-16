/**
 * blackout-commands.ts — Admin commands for per-resource blackout windows
 * (SCHED-2a.2 / ADR-0005).
 *
 * GUARANTEES:
 *   - authz first: requireCapability('schedule:manage_resources') BEFORE any
 *     data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Every mutation writes ONE audit_log row. Audit actions:
 *       'resource_blackout.created', 'resource_blackout.deleted'.
 *   - not_found when the resource/blackout is not visible in-org (RLS hides it).
 *   - ValidationError thrown when endAt <= startAt (DISTINCT from not_found).
 *   - createBlackout does NOT auto-cancel existing overlapping reservations
 *     (advisory-only gate; [VERIFY-3]).
 *   - `during` built ONLY as tstzrange($start, $end, '[)') — the single
 *     sanctioned half-open encoding (mirrors reservation_resource).
 *
 * TWO CALLING FORMS (mirrors resource-commands.ts):
 *   listBlackouts(session, input)               — app code.
 *   listBlackoutsWithDb(db, session, input)     — tests; inject pglite client.
 *   createBlackout(session, input)              — app code.
 *   createBlackoutWithDb(...)                   — tests.
 *   deleteBlackout(session, input)              — app code.
 *   deleteBlackoutWithDb(...)                   — tests.
 */
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { resourceBlackout, auditLog, resource } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError, toIso } from './internal.js';

/** Max length of the optional free-text blackout reason (spec §4: ~500). */
const BLACKOUT_REASON_MAX_LEN = 500;

// ─── Exported input / result types ───────────────────────────────────────────

/** The blackout view returned to API callers. */
export interface BlackoutView {
  id: string;
  resourceId: string;
  startAt: Date;
  endAt: Date;
  reason: string | null;
  createdBy: string;
  createdAt: Date;
}

/** Input to listBlackouts. */
export interface ListBlackoutsInput {
  resourceId: string;
}

/** Input to createBlackout. */
export interface CreateBlackoutInput {
  resourceId: string;
  startAt: Date;
  endAt: Date;
  reason?: string;
}

/** Result of createBlackout. */
export type CreateBlackoutResult =
  | { ok: true; blackout: BlackoutView }
  | { ok: false; reason: 'not_found' };

/** Input to deleteBlackout. */
export interface DeleteBlackoutInput {
  blackoutId: string;
}

/** Result of deleteBlackout. */
export type DeleteBlackoutResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' };

// ─── listBlackouts ────────────────────────────────────────────────────────────

async function _listBlackoutsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: ListBlackoutsInput,
): Promise<BlackoutView[]> {
  requireCapability(session, 'schedule:manage_resources');

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // RLS scopes to org. We extract lower/upper from the tstzrange via raw SQL
    // because Drizzle's typed select can't call lower()/upper() on customType.
    const result = await tx.execute(sql`
      SELECT
        id,
        resource_id,
        lower(during) AS start_at,
        upper(during) AS end_at,
        reason,
        created_by,
        created_at
      FROM resource_blackout
      WHERE resource_id = ${input.resourceId}::uuid
      ORDER BY lower(during)
    `);

    const rows = (result.rows ?? result) as unknown as Array<{
      id: string;
      resource_id: string;
      start_at: string | Date;
      end_at: string | Date;
      reason: string | null;
      created_by: string;
      created_at: string | Date;
    }>;

    return rows.map((row) => ({
      id: row.id,
      resourceId: row.resource_id,
      startAt: row.start_at instanceof Date ? row.start_at : new Date(row.start_at),
      endAt: row.end_at instanceof Date ? row.end_at : new Date(row.end_at),
      reason: row.reason ?? null,
      createdBy: row.created_by,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    }));
  });
}

export async function listBlackouts(
  session: AppSession | null | undefined,
  input: ListBlackoutsInput,
): Promise<BlackoutView[]> {
  const db = await getDb();
  return _listBlackoutsImpl(db, session, input);
}

export async function listBlackoutsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: ListBlackoutsInput,
): Promise<BlackoutView[]> {
  return _listBlackoutsImpl(db, session, input);
}

// ─── createBlackout ───────────────────────────────────────────────────────────

async function _createBlackoutImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CreateBlackoutInput,
): Promise<CreateBlackoutResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'schedule:manage_resources');

  // 2. VALIDATE: endAt must be strictly after startAt.
  //    Throws ValidationError (distinct from not_found — ADR-0005 invariant 9).
  if (input.endAt.getTime() <= input.startAt.getTime()) {
    throw new ValidationError(
      '[resource_blackout] endAt must be strictly after startAt.',
    );
  }

  // Cap the optional free-text reason (spec §4: ~500). A degenerate oversized
  // note is a malformed input, not a not_found — throw ValidationError.
  if (input.reason != null && input.reason.length > BLACKOUT_REASON_MAX_LEN) {
    throw new ValidationError(
      `[resource_blackout] reason must be ${BLACKOUT_REASON_MAX_LEN} characters or fewer.`,
    );
  }

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Verify the resource exists and is visible in-org (RLS handles org scoping).
    const resourceRows = await tx
      .select({ id: resource.id })
      .from(resource)
      .where(eq(resource.id, input.resourceId))
      .limit(1);

    if (!resourceRows[0]) {
      return { ok: false, reason: 'not_found' };
    }

    // 4. INSERT the blackout row. `during` built as the single sanctioned
    //    half-open tstzrange — same encoding as reservation_resource.
    const startIso = toIso(input.startAt);
    const endIso = toIso(input.endAt);

    const result = await tx.execute(sql`
      INSERT INTO resource_blackout
        (org_id, resource_id, during, reason, created_by)
      VALUES (
        ${sess.orgId}::uuid,
        ${input.resourceId}::uuid,
        tstzrange(${startIso}::timestamptz, ${endIso}::timestamptz, '[)'),
        ${input.reason ?? null},
        ${sess.userId}::uuid
      )
      RETURNING
        id,
        resource_id,
        lower(during) AS start_at,
        upper(during) AS end_at,
        reason,
        created_by,
        created_at
    `);

    const rows = (result.rows ?? result) as unknown as Array<{
      id: string;
      resource_id: string;
      start_at: string | Date;
      end_at: string | Date;
      reason: string | null;
      created_by: string;
      created_at: string | Date;
    }>;

    const row = rows[0];
    if (!row) {
      throw new Error('[resource_blackout] INSERT returned no row — unexpected DB error.');
    }

    // 5. Audit row — blackout creation is a recorded mutation.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'resource_blackout.created',
      entityType: 'resource_blackout',
      entityId: row.id,
      metadata: {
        resourceId: input.resourceId,
        startAt: startIso,
        endAt: endIso,
        reason: input.reason ?? null,
      },
    });

    return {
      ok: true,
      blackout: {
        id: row.id,
        resourceId: row.resource_id,
        startAt: row.start_at instanceof Date ? row.start_at : new Date(row.start_at),
        endAt: row.end_at instanceof Date ? row.end_at : new Date(row.end_at),
        reason: row.reason ?? null,
        createdBy: row.created_by,
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      },
    };
  });
}

export async function createBlackout(
  session: AppSession | null | undefined,
  input: CreateBlackoutInput,
): Promise<CreateBlackoutResult> {
  const db = await getDb();
  return _createBlackoutImpl(db, session, input);
}

export async function createBlackoutWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CreateBlackoutInput,
): Promise<CreateBlackoutResult> {
  return _createBlackoutImpl(db, session, input);
}

// ─── deleteBlackout ───────────────────────────────────────────────────────────

async function _deleteBlackoutImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: DeleteBlackoutInput,
): Promise<DeleteBlackoutResult> {
  requireCapability(session, 'schedule:manage_resources');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // Load the blackout row (RLS scopes to org — cross-org/unknown id → not_found).
    const rows = await tx
      .select({
        id: resourceBlackout.id,
        resourceId: resourceBlackout.resourceId,
      })
      .from(resourceBlackout)
      .where(eq(resourceBlackout.id, input.blackoutId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return { ok: false, reason: 'not_found' };
    }

    // Delete the blackout row.
    await tx.delete(resourceBlackout).where(eq(resourceBlackout.id, row.id));

    // Audit row — blackout deletion is a recorded mutation.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'resource_blackout.deleted',
      entityType: 'resource_blackout',
      entityId: row.id,
      metadata: { resourceId: row.resourceId },
    });

    return { ok: true };
  });
}

export async function deleteBlackout(
  session: AppSession | null | undefined,
  input: DeleteBlackoutInput,
): Promise<DeleteBlackoutResult> {
  const db = await getDb();
  return _deleteBlackoutImpl(db, session, input);
}

export async function deleteBlackoutWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: DeleteBlackoutInput,
): Promise<DeleteBlackoutResult> {
  return _deleteBlackoutImpl(db, session, input);
}
