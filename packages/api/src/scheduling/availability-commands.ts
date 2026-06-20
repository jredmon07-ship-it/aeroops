/**
 * availability-commands.ts — CRUD for per-resource operating-hours availability
 * windows. (Slice AV1.2)
 *
 * Manages resource_availability_window rows: each says "this resource is available
 * from start_minute to end_minute on day_of_week (1=Mon … 7=Sun, ISO 8601) in the
 * given IANA tz." The availability gate (gatedCreateOccurrence Step D3) unions a
 * resource's windows and checks the candidate is FULLY CONTAINED — warn or block
 * per dispatch_config.availability_mode, INERT when the resource has no windows.
 *
 * [VERIFY-AV1-A] (HARD COMPLIANCE LINE): availability windows are OPERATOR
 * SCHEDULING / OPERATING-HOURS data ONLY. This code computes NO FAA duty-time,
 * rest-period, flight-time-limit, or Part-117/135/121 determination. These are the
 * times the operator decided to make the resource available — nothing more.
 *
 * FUNCTIONS:
 *   listAvailabilityWindows   — schedule:manage_resources → list | not_found (resource visible)
 *   createAvailabilityWindow  — schedule:manage_resources → insert + audit | duplicate
 *   deleteAvailabilityWindow  — schedule:manage_resources → delete by id + audit | not_found
 *
 * GUARANTEES:
 *   - requireCapability FIRST (before any data access).
 *   - org_id from session only; cross-org resourceId → not_found (RLS).
 *   - Resource must be visible AND active (for create); visible (for list).
 *   - dow 1–7, startMinute 0–1439, endMinute 1–1440 AND > startMinute, tz non-empty
 *     IANA → ValidationError (thrown) on any failure.
 *   - 23505 natural-key violation → returned { ok:false, reason:'duplicate' }.
 *   - ONE audit row per mutation ('availability.window_added' / '.window_removed').
 *   - Returns the fresh window list after mutations.
 *   - Refusals returned; auth+validation thrown.
 *
 * TWO CALLING FORMS per function:
 *   fn(session, input)        — app code.
 *   fnWithDb(db, session, in) — tests.
 */

import { z } from 'zod';
import { eq, and, asc } from 'drizzle-orm';
import { resourceAvailabilityWindow, resource, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError, isValidIanaTz } from './internal.js';
import { isUniqueViolation } from '../dispatch/internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── View + result types ──────────────────────────────────────────────────────

/** One operating-hours window as returned by the API. */
export interface AvailabilityWindowView {
  id: string;
  resourceId: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  tz: string;
  createdBy: string;
  createdAt: Date;
}

export type ListAvailabilityWindowsResult =
  | { ok: true; windows: AvailabilityWindowView[] }
  | { ok: false; reason: 'not_found' };

export type CreateAvailabilityWindowResult =
  | { ok: true; windows: AvailabilityWindowView[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'duplicate' };

export type DeleteAvailabilityWindowResult =
  | { ok: true; windows: AvailabilityWindowView[] }
  | { ok: false; reason: 'not_found' };

export interface ListAvailabilityWindowsInput {
  resourceId: string;
}

export interface CreateAvailabilityWindowInput {
  resourceId: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  tz: string;
}

export interface DeleteAvailabilityWindowInput {
  windowId: string;
}

// ─── Input schemas ────────────────────────────────────────────────────────────

const listInputSchema = z.object({
  resourceId: z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
});

const createInputSchema = z.object({
  resourceId:  z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
  dayOfWeek:   z.number().int().min(1, { message: 'dayOfWeek must be 1..7' }).max(7, { message: 'dayOfWeek must be 1..7' }),
  startMinute: z.number().int().min(0, { message: 'startMinute must be 0..1439' }).max(1439, { message: 'startMinute must be 0..1439' }),
  endMinute:   z.number().int().min(1, { message: 'endMinute must be 1..1440' }).max(1440, { message: 'endMinute must be 1..1440' }),
  tz:          z.string().min(1, { message: 'tz is required' }),
});

const deleteInputSchema = z.object({
  windowId: z.string().regex(UUID_RE, { message: 'windowId must be a UUID' }),
});

// ─── Shared loader ────────────────────────────────────────────────────────────

/** loadWindowViews — fresh list of a resource's windows (RLS-scoped). */
async function loadWindowViews(tx: AnyDb, resourceId: string): Promise<AvailabilityWindowView[]> {
  const rows = await tx
    .select({
      id:          resourceAvailabilityWindow.id,
      resourceId:  resourceAvailabilityWindow.resourceId,
      dayOfWeek:   resourceAvailabilityWindow.dayOfWeek,
      startMinute: resourceAvailabilityWindow.startMinute,
      endMinute:   resourceAvailabilityWindow.endMinute,
      tz:          resourceAvailabilityWindow.tz,
      createdBy:   resourceAvailabilityWindow.createdBy,
      createdAt:   resourceAvailabilityWindow.createdAt,
    })
    .from(resourceAvailabilityWindow)
    .where(eq(resourceAvailabilityWindow.resourceId, resourceId))
    .orderBy(
      asc(resourceAvailabilityWindow.dayOfWeek),
      asc(resourceAvailabilityWindow.startMinute),
      asc(resourceAvailabilityWindow.endMinute),
    );

  return rows.map((r) => ({
    id:          r.id,
    resourceId:  r.resourceId,
    dayOfWeek:   r.dayOfWeek,
    startMinute: r.startMinute,
    endMinute:   r.endMinute,
    tz:          r.tz,
    createdBy:   r.createdBy,
    createdAt:   r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
  }));
}

// ─── listAvailabilityWindows ──────────────────────────────────────────────────

async function _listAvailabilityWindowsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<ListAvailabilityWindowsResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'schedule:manage_resources');

  // 2. VALIDATE.
  const parsed = listInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[scheduling] invalid listAvailabilityWindows input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // 3. Verify resource is visible in org (RLS-scoped).
    const resRows = await tx
      .select({ id: resource.id })
      .from(resource)
      .where(eq(resource.id, resourceId))
      .limit(1);
    if (!resRows[0]) return { ok: false, reason: 'not_found' } as const;

    const windows = await loadWindowViews(tx, resourceId);
    return { ok: true, windows } as const;
  });
}

export async function listAvailabilityWindows(
  session: AppSession | null | undefined,
  input: ListAvailabilityWindowsInput,
): Promise<ListAvailabilityWindowsResult> {
  const db = await getDb();
  return _listAvailabilityWindowsImpl(db, session, input);
}

export async function listAvailabilityWindowsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: ListAvailabilityWindowsInput,
): Promise<ListAvailabilityWindowsResult> {
  return _listAvailabilityWindowsImpl(db, session, input);
}

// ─── createAvailabilityWindow ─────────────────────────────────────────────────

async function _createAvailabilityWindowImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CreateAvailabilityWindowResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'schedule:manage_resources');

  // 2. VALIDATE.
  const parsed = createInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[scheduling] invalid createAvailabilityWindow input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceId, dayOfWeek, startMinute, endMinute, tz } = parsed.data;

  // 3. Cross-field + tz validation (matches DB CHECKs; thrown, not returned).
  if (endMinute <= startMinute) {
    throw new ValidationError('[scheduling] endMinute must be strictly after startMinute (no overnight wrap — use two windows)');
  }
  if (!isValidIanaTz(tz)) {
    throw new ValidationError(`[scheduling] invalid IANA timezone: '${tz}'`);
  }

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 4. Verify resource is visible AND active.
    const resRows = await tx
      .select({ id: resource.id, active: resource.active })
      .from(resource)
      .where(eq(resource.id, resourceId))
      .limit(1);
    const res = resRows[0];
    if (!res || !res.active) return { ok: false, reason: 'not_found' } as const;

    // 5. INSERT. 23505 natural-key violation → duplicate.
    try {
      await tx.insert(resourceAvailabilityWindow).values({
        orgId:       sess.orgId,
        resourceId,
        dayOfWeek,
        startMinute,
        endMinute,
        tz,
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
      action:      'availability.window_added',
      entityType:  'resource_availability_window',
      entityId:    resourceId,
      metadata:    { resourceId, dayOfWeek, startMinute, endMinute, tz },
    });

    // 7. Return fresh window list.
    const windows = await loadWindowViews(tx, resourceId);
    return { ok: true, windows } as const;
  });
}

export async function createAvailabilityWindow(
  session: AppSession | null | undefined,
  input: CreateAvailabilityWindowInput,
): Promise<CreateAvailabilityWindowResult> {
  const db = await getDb();
  return _createAvailabilityWindowImpl(db, session, input);
}

export async function createAvailabilityWindowWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CreateAvailabilityWindowInput,
): Promise<CreateAvailabilityWindowResult> {
  return _createAvailabilityWindowImpl(db, session, input);
}

// ─── deleteAvailabilityWindow ─────────────────────────────────────────────────

async function _deleteAvailabilityWindowImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<DeleteAvailabilityWindowResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'schedule:manage_resources');

  // 2. VALIDATE.
  const parsed = deleteInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[scheduling] invalid deleteAvailabilityWindow input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { windowId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load the window BEFORE delete (capture fields for audit + the resourceId
    //    needed to return the fresh list). RLS-scoped → cross-org id not visible.
    const existing = await tx
      .select({
        id:          resourceAvailabilityWindow.id,
        resourceId:  resourceAvailabilityWindow.resourceId,
        dayOfWeek:   resourceAvailabilityWindow.dayOfWeek,
        startMinute: resourceAvailabilityWindow.startMinute,
        endMinute:   resourceAvailabilityWindow.endMinute,
        tz:          resourceAvailabilityWindow.tz,
      })
      .from(resourceAvailabilityWindow)
      .where(eq(resourceAvailabilityWindow.id, windowId))
      .limit(1);
    const row = existing[0];
    if (!row) return { ok: false, reason: 'not_found' } as const;

    // 4. DELETE by id (RLS-scoped).
    const deleted = await tx
      .delete(resourceAvailabilityWindow)
      .where(
        and(
          eq(resourceAvailabilityWindow.id, windowId),
          eq(resourceAvailabilityWindow.resourceId, row.resourceId),
        ),
      )
      .returning({ id: resourceAvailabilityWindow.id });
    if (deleted.length === 0) return { ok: false, reason: 'not_found' } as const;

    // 5. ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'availability.window_removed',
      entityType:  'resource_availability_window',
      entityId:    row.resourceId,
      metadata: {
        resourceId:  row.resourceId,
        windowId,
        dayOfWeek:   row.dayOfWeek,
        startMinute: row.startMinute,
        endMinute:   row.endMinute,
        tz:          row.tz,
      },
    });

    // 6. Return fresh window list.
    const windows = await loadWindowViews(tx, row.resourceId);
    return { ok: true, windows } as const;
  });
}

export async function deleteAvailabilityWindow(
  session: AppSession | null | undefined,
  input: DeleteAvailabilityWindowInput,
): Promise<DeleteAvailabilityWindowResult> {
  const db = await getDb();
  return _deleteAvailabilityWindowImpl(db, session, input);
}

export async function deleteAvailabilityWindowWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: DeleteAvailabilityWindowInput,
): Promise<DeleteAvailabilityWindowResult> {
  return _deleteAvailabilityWindowImpl(db, session, input);
}
