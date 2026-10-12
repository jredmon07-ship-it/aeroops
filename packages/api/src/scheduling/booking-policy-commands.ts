/**
 * booking-policy-commands.ts — Admin commands for per-resource booking policies
 * (SCHED-2a.2 / ADR-0005).
 *
 * GUARANTEES:
 *   - authz first: requireCapability('schedule:manage_resources') BEFORE any
 *     data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Every mutation writes ONE audit_log row (policy is a record — no silent
 *     mutation). Audit actions: 'booking_policy.upserted', 'booking_policy.cleared'.
 *   - not_found when the resource/policy is not visible in-org (RLS hides it).
 *   - ValidationError thrown for negative/zero int values (mirrors DB CHECKs).
 *   - NO required_tags fields — DEFERRED (Scope Amendment 2026-06-16, maintainer).
 *   - NO listOrgBookingTags — DEFERRED.
 *
 * TWO CALLING FORMS (mirrors resource-commands.ts):
 *   getBookingPolicy(session, input)            — app code.
 *   getBookingPolicyWithDb(db, session, input)  — tests; inject pglite client.
 *   upsertBookingPolicy(session, input)         — app code.
 *   upsertBookingPolicyWithDb(...)              — tests.
 *   clearBookingPolicy(session, input)          — app code.
 *   clearBookingPolicyWithDb(...)               — tests.
 */
import { eq } from 'drizzle-orm';
import { bookingPolicy, auditLog, resource } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from './internal.js';

// ─── Exported input / result types ───────────────────────────────────────────

/** The booking policy view returned to API callers. */
export interface BookingPolicyView {
  id: string;
  resourceId: string;
  maxDurationMinutes: number | null;
  maxAdvanceDays: number | null;
  minAdvanceMinutes: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Input to getBookingPolicy. */
export interface GetBookingPolicyInput {
  resourceId: string;
}

/** Input to upsertBookingPolicy. */
export interface UpsertBookingPolicyInput {
  resourceId: string;
  maxDurationMinutes?: number | null;
  maxAdvanceDays?: number | null;
  minAdvanceMinutes?: number | null;
}

/** Result of upsertBookingPolicy. */
export type UpsertBookingPolicyResult =
  | { ok: true; policy: BookingPolicyView }
  | { ok: false; reason: 'not_found' };

/** Input to clearBookingPolicy. */
export interface ClearBookingPolicyInput {
  resourceId: string;
}

/** Result of clearBookingPolicy. */
export type ClearBookingPolicyResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' };

// ─── Shape validation ──────────────────────────────────────────────────────────

/**
 * validatePolicyValues — mirrors the DB CHECKs in migration 0003.
 *   max_duration_minutes: must be > 0 if set.
 *   max_advance_days:     must be >= 0 if set.
 *   min_advance_minutes:  must be >= 0 if set.
 * Throws ValidationError (not a returned result) — same posture as resource-commands.
 */
function validatePolicyValues(input: UpsertBookingPolicyInput): void {
  if (input.maxDurationMinutes !== undefined && input.maxDurationMinutes !== null) {
    if (!Number.isInteger(input.maxDurationMinutes) || input.maxDurationMinutes <= 0) {
      throw new ValidationError(
        '[booking_policy] maxDurationMinutes must be a positive integer (> 0).',
      );
    }
  }
  if (input.maxAdvanceDays !== undefined && input.maxAdvanceDays !== null) {
    if (!Number.isInteger(input.maxAdvanceDays) || input.maxAdvanceDays < 0) {
      throw new ValidationError(
        '[booking_policy] maxAdvanceDays must be a non-negative integer (>= 0).',
      );
    }
  }
  if (input.minAdvanceMinutes !== undefined && input.minAdvanceMinutes !== null) {
    if (!Number.isInteger(input.minAdvanceMinutes) || input.minAdvanceMinutes < 0) {
      throw new ValidationError(
        '[booking_policy] minAdvanceMinutes must be a non-negative integer (>= 0).',
      );
    }
  }
}

// ─── getBookingPolicy ─────────────────────────────────────────────────────────

async function _getBookingPolicyImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetBookingPolicyInput,
): Promise<BookingPolicyView | null> {
  requireCapability(session, 'schedule:manage_resources');

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const rows = await tx
      .select()
      .from(bookingPolicy)
      .where(eq(bookingPolicy.resourceId, input.resourceId))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      resourceId: row.resourceId,
      maxDurationMinutes: row.maxDurationMinutes ?? null,
      maxAdvanceDays: row.maxAdvanceDays ?? null,
      minAdvanceMinutes: row.minAdvanceMinutes ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

export async function getBookingPolicy(
  session: AppSession | null | undefined,
  input: GetBookingPolicyInput,
): Promise<BookingPolicyView | null> {
  const db = await getDb();
  return _getBookingPolicyImpl(db, session, input);
}

export async function getBookingPolicyWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetBookingPolicyInput,
): Promise<BookingPolicyView | null> {
  return _getBookingPolicyImpl(db, session, input);
}

// ─── upsertBookingPolicy ──────────────────────────────────────────────────────

async function _upsertBookingPolicyImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: UpsertBookingPolicyInput,
): Promise<UpsertBookingPolicyResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'schedule:manage_resources');

  // 2. VALIDATE shape (mirrors DB CHECKs; throws ValidationError).
  validatePolicyValues(input);

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

    // 4. UPSERT the policy row (INSERT … ON CONFLICT (resource_id) DO UPDATE).
    //    org_id is always from the session (RLS-enforced).
    const now = new Date();
    const [row] = await tx
      .insert(bookingPolicy)
      .values({
        orgId: sess.orgId,
        resourceId: input.resourceId,
        maxDurationMinutes: input.maxDurationMinutes ?? null,
        maxAdvanceDays: input.maxAdvanceDays ?? null,
        minAdvanceMinutes: input.minAdvanceMinutes ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: bookingPolicy.resourceId,
        set: {
          maxDurationMinutes: input.maxDurationMinutes ?? null,
          maxAdvanceDays: input.maxAdvanceDays ?? null,
          minAdvanceMinutes: input.minAdvanceMinutes ?? null,
          updatedAt: now,
        },
      })
      .returning();

    if (!row) {
      throw new Error('[booking_policy] UPSERT returned no row — unexpected DB error.');
    }

    // 5. Audit row — policy upsert is a recorded mutation.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'booking_policy.upserted',
      entityType: 'booking_policy',
      entityId: row.id,
      metadata: {
        resourceId: input.resourceId,
        maxDurationMinutes: row.maxDurationMinutes ?? null,
        maxAdvanceDays: row.maxAdvanceDays ?? null,
        minAdvanceMinutes: row.minAdvanceMinutes ?? null,
      },
    });

    return {
      ok: true,
      policy: {
        id: row.id,
        resourceId: row.resourceId,
        maxDurationMinutes: row.maxDurationMinutes ?? null,
        maxAdvanceDays: row.maxAdvanceDays ?? null,
        minAdvanceMinutes: row.minAdvanceMinutes ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    };
  });
}

export async function upsertBookingPolicy(
  session: AppSession | null | undefined,
  input: UpsertBookingPolicyInput,
): Promise<UpsertBookingPolicyResult> {
  const db = await getDb();
  return _upsertBookingPolicyImpl(db, session, input);
}

export async function upsertBookingPolicyWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: UpsertBookingPolicyInput,
): Promise<UpsertBookingPolicyResult> {
  return _upsertBookingPolicyImpl(db, session, input);
}

// ─── clearBookingPolicy ───────────────────────────────────────────────────────

async function _clearBookingPolicyImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: ClearBookingPolicyInput,
): Promise<ClearBookingPolicyResult> {
  requireCapability(session, 'schedule:manage_resources');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // Load the existing policy row (RLS-scoped).
    const rows = await tx
      .select({ id: bookingPolicy.id })
      .from(bookingPolicy)
      .where(eq(bookingPolicy.resourceId, input.resourceId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return { ok: false, reason: 'not_found' };
    }

    // Delete the policy row → resource reverts to open booking (Slice-1 behaviour).
    await tx.delete(bookingPolicy).where(eq(bookingPolicy.id, row.id));

    // Audit row — clearing a policy is a recorded mutation.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'booking_policy.cleared',
      entityType: 'booking_policy',
      entityId: row.id,
      metadata: { resourceId: input.resourceId },
    });

    return { ok: true };
  });
}

export async function clearBookingPolicy(
  session: AppSession | null | undefined,
  input: ClearBookingPolicyInput,
): Promise<ClearBookingPolicyResult> {
  const db = await getDb();
  return _clearBookingPolicyImpl(db, session, input);
}

export async function clearBookingPolicyWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: ClearBookingPolicyInput,
): Promise<ClearBookingPolicyResult> {
  return _clearBookingPolicyImpl(db, session, input);
}
