/**
 * activity/actions.ts — Server action for Slice A1.2 activity feed.
 *
 * Pattern mirrors reporting/reports/actions.ts:
 *   1. await auth() → session.
 *   2. Call @aeroops/api listActivity (requireCapability enforced inside).
 *   3. Map ForbiddenError / UnauthenticatedError → typed result.
 *   4. Serialize Dates → ISO strings at the action boundary.
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 * RLS + org_id scoping enforced inside the API function (session only).
 */
'use server';

import { auth } from '@/auth';
import {
  listActivity,
  ForbiddenError,
  UnauthenticatedError,
} from '@aeroops/api';
import type { ListActivityOptions } from '@aeroops/api';

// ─── Error shapes ──────────────────────────────────────────────────────────────

export type AuthErrorResult =
  | { error: 'forbidden' }
  | { error: 'unauthenticated' };

export type ServerErrorResult = { error: 'server'; message?: string };

function mapAuthError(err: unknown): AuthErrorResult | null {
  if (err instanceof ForbiddenError) return { error: 'forbidden' };
  if (err instanceof UnauthenticatedError) return { error: 'unauthenticated' };
  return null;
}

// ─── Serialized types (Dates → ISO strings) ───────────────────────────────────

/** A single activity entry with createdAt serialized to ISO string. */
export interface SerializedActivityEntry {
  id: string;
  actorName: string;
  summary: string;
  entityType: string;
  entityPath: string | null;
  createdAt: string; // ISO 8601
}

/** Serialized cursor — both Date fields converted to ISO strings. */
export interface SerializedActivityCursor {
  createdAt: string; // ISO 8601
  id: string;
}

/** Paginated result with serialized entries + optional nextCursor. */
export interface SerializedListActivityResult {
  entries: SerializedActivityEntry[];
  nextCursor?: SerializedActivityCursor;
}

export type ListActivityActionResult =
  | { ok: true; data: SerializedListActivityResult }
  | AuthErrorResult
  | ServerErrorResult;

// ─── Action ───────────────────────────────────────────────────────────────────

/**
 * listActivityAction — server action for the activity feed page.
 *
 * @param opts.limit  — rows per page (default 50, cap 100 enforced by the API).
 * @param opts.cursor — serialized keyset cursor from a prior call's nextCursor.
 *                      Both ISO strings are re-hydrated to Date before passing
 *                      to the API.
 */
export async function listActivityAction(opts?: {
  limit?: number;
  cursor?: SerializedActivityCursor;
}): Promise<ListActivityActionResult> {
  const session = await auth();

  // Re-hydrate serialized cursor → API cursor (Dates).
  const apiOpts: ListActivityOptions = {
    limit: opts?.limit,
    cursor: opts?.cursor
      ? {
          createdAt: new Date(opts.cursor.createdAt),
          id: opts.cursor.id,
        }
      : undefined,
  };

  try {
    const result = await listActivity(session, apiOpts);

    const serialized: SerializedListActivityResult = {
      entries: result.entries.map((e) => ({
        id: e.id,
        actorName: e.actorName,
        summary: e.summary,
        entityType: e.entityType,
        entityPath: e.entityPath,
        createdAt: e.createdAt instanceof Date
          ? e.createdAt.toISOString()
          : String(e.createdAt),
      })),
      nextCursor: result.nextCursor
        ? {
            createdAt: result.nextCursor.createdAt instanceof Date
              ? result.nextCursor.createdAt.toISOString()
              : String(result.nextCursor.createdAt),
            id: result.nextCursor.id,
          }
        : undefined,
    };

    return { ok: true, data: serialized };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}
