/**
 * dispatch-gate/requirements.ts — CRUD for per-aircraft dispatch requirements.
 *
 * Manages free-text required-tag labels on aircraft (resources). A pilot must
 * carry a matching member_tag to be checked out when requirements are set.
 *
 * [VERIFY-3c-A] (HARD COMPLIANCE LINE): requiredTag is a FREE-TEXT operator
 * label ONLY. This code computes/interprets NO FAA currency, medical, flight-
 * review, Part 61/141, endorsement, or eligibility status. Eligibility blocking
 * = the operator enforcing their own label rule. Compliance confirms at QA.
 *
 * FUNCTIONS:
 *   getResourceRequiredTags   — dispatch:access → list|not_found (aircraft visible)
 *   addResourceRequiredTag    — dispatch:manage_requirements → add tag + audit
 *   removeResourceRequiredTag — dispatch:manage_requirements → remove by id + audit
 *
 * GUARANTEES:
 *   - requireCapability FIRST (before any data access).
 *   - org_id from session only; cross-org resourceId → not_found (RLS).
 *   - Aircraft must be kind='aircraft' AND active (for add); kind='aircraft' (for get/remove).
 *   - Tag trimmed before insert; empty after trim → ValidationError (thrown).
 *   - 23505 unique violation → returned { ok:false, reason:'duplicate' }.
 *   - ONE audit row per mutation ('dispatch.requirement_added' / 'dispatch.requirement_removed').
 *   - Returns fresh tag list after mutations.
 *   - Refusals returned; auth+validation thrown.
 *
 * TWO CALLING FORMS per function:
 *   fn(session, input)        — app code.
 *   fnWithDb(db, session, in) — tests.
 */

import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import {
  dispatchRequirement,
  resource,
  auditLog,
} from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { isUniqueViolation } from '../dispatch/internal.js';
import { loadRequiredTagViews } from './internal.js';
import type {
  GetResourceRequiredTagsResult,
  AddResourceRequiredTagResult,
  RemoveResourceRequiredTagResult,
} from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Input schemas ────────────────────────────────────────────────────────────

const getTagsInputSchema = z.object({
  resourceId: z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
});

const addTagInputSchema = z.object({
  resourceId:  z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
  requiredTag: z.string(),
});

const removeTagInputSchema = z.object({
  resourceId:    z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
  requirementId: z.string().regex(UUID_RE, { message: 'requirementId must be a UUID' }),
});

export interface GetResourceRequiredTagsInput {
  resourceId: string;
}

export interface AddResourceRequiredTagInput {
  resourceId:  string;
  requiredTag: string;
}

export interface RemoveResourceRequiredTagInput {
  resourceId:    string;
  requirementId: string;
}

// ─── getResourceRequiredTags ──────────────────────────────────────────────────

async function _getResourceRequiredTagsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GetResourceRequiredTagsResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'dispatch:access');

  // 2. VALIDATE input.
  const parsed = getTagsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[dispatch-gate] invalid getResourceRequiredTags input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // 3. Verify resource is visible in org AND is kind='aircraft'.
    const resRows = await tx
      .select({ id: resource.id, kind: resource.kind })
      .from(resource)
      .where(eq(resource.id, resourceId))
      .limit(1);

    const res = resRows[0];
    if (!res || res.kind !== 'aircraft') {
      return { ok: false, reason: 'not_found' } as const;
    }

    // 4. Load and return tags.
    const tags = await loadRequiredTagViews(tx, resourceId);
    return { ok: true, tags } as const;
  });
}

export async function getResourceRequiredTags(
  session: AppSession | null | undefined,
  input: GetResourceRequiredTagsInput,
): Promise<GetResourceRequiredTagsResult> {
  const db = await getDb();
  return _getResourceRequiredTagsImpl(db, session, input);
}

export async function getResourceRequiredTagsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetResourceRequiredTagsInput,
): Promise<GetResourceRequiredTagsResult> {
  return _getResourceRequiredTagsImpl(db, session, input);
}

// ─── addResourceRequiredTag ───────────────────────────────────────────────────

async function _addResourceRequiredTagImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<AddResourceRequiredTagResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'dispatch:manage_requirements');

  // 2. VALIDATE input.
  const parsed = addTagInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[dispatch-gate] invalid addResourceRequiredTag input: ${first?.message ?? 'unknown'}`,
    );
  }

  // 3. Trim tag; empty after trim → ValidationError (thrown).
  const trimmedTag = parsed.data.requiredTag.trim();
  if (trimmedTag.length === 0) {
    throw new ValidationError(
      '[dispatch-gate] addResourceRequiredTag: requiredTag must not be empty after trimming',
    );
  }
  const { resourceId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 4. Verify resource is visible, kind='aircraft', AND active.
    const resRows = await tx
      .select({ id: resource.id, kind: resource.kind, active: resource.active })
      .from(resource)
      .where(eq(resource.id, resourceId))
      .limit(1);

    const res = resRows[0];
    if (!res || res.kind !== 'aircraft' || !res.active) {
      return { ok: false, reason: 'not_found' } as const;
    }

    // 5. INSERT. 23505 unique violation → duplicate.
    try {
      await tx.insert(dispatchRequirement).values({
        orgId:       sess.orgId,
        resourceId,
        requiredTag: trimmedTag,
        createdBy:   sess.userId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { ok: false, reason: 'duplicate' } as const;
      }
      throw err;
    }

    // 6. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'dispatch.requirement_added',
      entityType:  'dispatch_requirement',
      entityId:    resourceId,
      metadata:    { resourceId, requiredTag: trimmedTag },
    });

    // 7. Return fresh tag list.
    const tags = await loadRequiredTagViews(tx, resourceId);
    return { ok: true, tags } as const;
  });
}

export async function addResourceRequiredTag(
  session: AppSession | null | undefined,
  input: AddResourceRequiredTagInput,
): Promise<AddResourceRequiredTagResult> {
  const db = await getDb();
  return _addResourceRequiredTagImpl(db, session, input);
}

export async function addResourceRequiredTagWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: AddResourceRequiredTagInput,
): Promise<AddResourceRequiredTagResult> {
  return _addResourceRequiredTagImpl(db, session, input);
}

// ─── removeResourceRequiredTag ────────────────────────────────────────────────

async function _removeResourceRequiredTagImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<RemoveResourceRequiredTagResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'dispatch:manage_requirements');

  // 2. VALIDATE input.
  const parsed = removeTagInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[dispatch-gate] invalid removeResourceRequiredTag input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceId, requirementId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load the requirement row BEFORE delete (to capture tag for audit).
    const existing = await tx
      .select({
        id:          dispatchRequirement.id,
        requiredTag: dispatchRequirement.requiredTag,
      })
      .from(dispatchRequirement)
      .where(eq(dispatchRequirement.id, requirementId))
      .limit(1);

    const reqRow = existing[0];
    if (!reqRow) return { ok: false, reason: 'not_found' } as const;

    // 4. DELETE by id (RLS-scoped).
    const deleted = await tx
      .delete(dispatchRequirement)
      .where(
        and(
          eq(dispatchRequirement.id, requirementId),
          eq(dispatchRequirement.resourceId, resourceId),
        ),
      )
      .returning({ id: dispatchRequirement.id });

    if (deleted.length === 0) return { ok: false, reason: 'not_found' } as const;

    // 5. ONE audit row (tag string captured before delete).
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'dispatch.requirement_removed',
      entityType:  'dispatch_requirement',
      entityId:    resourceId,
      metadata:    { resourceId, requirementId, requiredTag: reqRow.requiredTag },
    });

    // 6. Return fresh tag list.
    const tags = await loadRequiredTagViews(tx, resourceId);
    return { ok: true, tags } as const;
  });
}

export async function removeResourceRequiredTag(
  session: AppSession | null | undefined,
  input: RemoveResourceRequiredTagInput,
): Promise<RemoveResourceRequiredTagResult> {
  const db = await getDb();
  return _removeResourceRequiredTagImpl(db, session, input);
}

export async function removeResourceRequiredTagWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: RemoveResourceRequiredTagInput,
): Promise<RemoveResourceRequiredTagResult> {
  return _removeResourceRequiredTagImpl(db, session, input);
}
