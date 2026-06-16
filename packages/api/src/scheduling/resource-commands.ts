/**
 * resource-commands.ts — Resource create + deactivate mutations (SCHED-1).
 *
 * GUARANTEES:
 *   - authz first: requireCapability('schedule:manage_resources') BEFORE any
 *     data access.
 *   - Shape invariant (mirrors resource_kind_shape_check in DB): validated in
 *     app code before INSERT; DB CHECK is the backstop, not the sole guard.
 *   - org_id comes ONLY from the session (withSessionOrgContextWithDb).
 *   - every mutation writes ONE audit_log row (resources are records — no
 *     silent mutation).
 *   - deactivateResource is a soft-delete only (active=false); hard-delete is
 *     structurally prevented by ON DELETE RESTRICT on reservation_resource.
 *
 * TWO CALLING FORMS (mirrors create-reservation.ts):
 *   createResource(session, input)               — app code; uses getDb() internally.
 *   createResourceWithDb(db, session, input)     — tests; inject pglite client.
 *   deactivateResource(session, input)           — app code.
 *   deactivateResourceWithDb(db, session, input) — tests.
 */
import { eq } from 'drizzle-orm';
import { resource, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from './internal.js';

// ─── Exported input / result types ───────────────────────────────────────────

/**
 * CreateResourceInput — validated in app code before INSERT.
 * Only aircraft + instructor are creatable in Slice 1 (ADR-0004 §Forward-compat).
 * Shape invariant:
 *   aircraft  → tailNumber required, instructorUserId must be absent/null.
 *   instructor → instructorUserId required, tailNumber must be absent/null.
 */
export interface CreateResourceInput {
  kind: 'aircraft' | 'instructor';
  displayName: string;
  tailNumber?: string;
  instructorUserId?: string;
}

/** The resource row returned on successful creation. */
export interface CreatedResource {
  id: string;
  orgId: string;
  kind: string;
  displayName: string;
  tailNumber: string | null;
  instructorUserId: string | null;
  active: boolean;
}

/** DeactivateResourceInput */
export interface DeactivateResourceInput {
  resourceId: string;
}

/**
 * DeactivateResult — discriminated union.
 *   ok:true              → resource is now inactive (soft-deleted).
 *   ok:false not_found   → no resource with that id visible in-org (RLS-scoped).
 */
export type DeactivateResult = { ok: true } | { ok: false; reason: 'not_found' };

// ─── Shape validation (mirrors resource_kind_shape_check) ────────────────────

/**
 * validateResourceShape — enforces the per-kind column constraints in app code.
 * Throws ValidationError with a clear message BEFORE attempting any DB write.
 * The DB CHECK is the authoritative backstop; this is the fast-fail app guard.
 */
function validateResourceShape(input: CreateResourceInput): void {
  if (input.kind === 'aircraft') {
    if (!input.tailNumber) {
      throw new ValidationError(
        '[resource] kind=aircraft requires tailNumber to be present and non-empty.',
      );
    }
    if (input.instructorUserId) {
      throw new ValidationError(
        '[resource] kind=aircraft must NOT have instructorUserId (aircraft is not an instructor).',
      );
    }
  } else if (input.kind === 'instructor') {
    if (!input.instructorUserId) {
      throw new ValidationError(
        '[resource] kind=instructor requires instructorUserId to be present and non-empty.',
      );
    }
    if (input.tailNumber) {
      throw new ValidationError(
        '[resource] kind=instructor must NOT have tailNumber (instructor is not an aircraft).',
      );
    }
  } else {
    // TypeScript narrows input.kind to never here, but guard for runtime safety.
    throw new ValidationError(
      `[resource] kind '${String((input as { kind: unknown }).kind)}' is not creatable in Slice 1. ` +
        `Only 'aircraft' and 'instructor' are supported.`,
    );
  }
}

// ─── createResource ──────────────────────────────────────────────────────────

async function _createResourceImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CreateResourceInput,
): Promise<CreatedResource> {
  // 1. AUTHZ FIRST — before any data access.
  requireCapability(session, 'schedule:manage_resources');

  // 2. VALIDATE shape before any DB work.
  validateResourceShape(input);

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. INSERT — org_id from session only.
    const [row] = await tx
      .insert(resource)
      .values({
        orgId: sess.orgId,
        kind: input.kind,
        displayName: input.displayName,
        tailNumber: input.tailNumber ?? null,
        instructorUserId: input.instructorUserId ?? null,
        active: true,
      })
      .returning({
        id: resource.id,
        orgId: resource.orgId,
        kind: resource.kind,
        displayName: resource.displayName,
        tailNumber: resource.tailNumber,
        instructorUserId: resource.instructorUserId,
        active: resource.active,
      });

    if (!row) {
      throw new Error('[resource] INSERT returned no row — unexpected DB error.');
    }

    // 4. Audit row — resources are records (no silent mutation).
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'resource.created',
      entityType: 'resource',
      entityId: row.id,
      metadata: {
        kind: row.kind,
        displayName: row.displayName,
        tailNumber: row.tailNumber ?? null,
        instructorUserId: row.instructorUserId ?? null,
      },
    });

    return {
      id: row.id,
      orgId: row.orgId,
      kind: row.kind,
      displayName: row.displayName,
      tailNumber: row.tailNumber ?? null,
      instructorUserId: row.instructorUserId ?? null,
      active: row.active,
    };
  });
}

/**
 * createResource — create a bookable resource for the authenticated org.
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param input   - { kind, displayName, tailNumber?, instructorUserId? }.
 * @returns CreatedResource — the newly inserted row.
 * @throws UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function createResource(
  session: AppSession | null | undefined,
  input: CreateResourceInput,
): Promise<CreatedResource> {
  const db = await getDb();
  return _createResourceImpl(db, session, input);
}

/** createResourceWithDb — test form; inject a pglite client. */
export async function createResourceWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CreateResourceInput,
): Promise<CreatedResource> {
  return _createResourceImpl(db, session, input);
}

// ─── deactivateResource ───────────────────────────────────────────────────────

async function _deactivateResourceImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: DeactivateResourceInput,
): Promise<DeactivateResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'schedule:manage_resources');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 2. Load the resource (RLS scopes to org — cross-org/unknown id → not_found).
    const rows = await tx
      .select({ id: resource.id, active: resource.active })
      .from(resource)
      .where(eq(resource.id, input.resourceId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return { ok: false, reason: 'not_found' };
    }

    // 3. Soft-delete: set active=false. Never hard-delete (ON DELETE RESTRICT on
    //    reservation_resource ensures referential integrity is structural).
    await tx
      .update(resource)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(resource.id, input.resourceId));

    // 4. Audit row — deactivation is a recorded mutation.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'resource.deactivated',
      entityType: 'resource',
      entityId: input.resourceId,
      metadata: {},
    });

    return { ok: true };
  });
}

/**
 * deactivateResource — soft-delete a resource in the authenticated org.
 *
 * Sets resource.active=false. Never hard-deletes (ON DELETE RESTRICT).
 *
 * @param session - AppSession; null/undefined → UnauthenticatedError.
 * @param input   - { resourceId }.
 * @returns DeactivateResult — ok:true, or ok:false reason:'not_found'.
 * @throws  UnauthenticatedError | ForbiddenError.
 */
export async function deactivateResource(
  session: AppSession | null | undefined,
  input: DeactivateResourceInput,
): Promise<DeactivateResult> {
  const db = await getDb();
  return _deactivateResourceImpl(db, session, input);
}

/** deactivateResourceWithDb — test form; inject a pglite client. */
export async function deactivateResourceWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: DeactivateResourceInput,
): Promise<DeactivateResult> {
  return _deactivateResourceImpl(db, session, input);
}
