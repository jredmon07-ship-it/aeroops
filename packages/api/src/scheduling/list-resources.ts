/**
 * list-resources.ts — Resource read surface (SCHED-1).
 *
 * Returns active (and optionally inactive) resources for the session org,
 * ordered by kind then displayName. Backs the resource picker on the
 * scheduling board / admin panel.
 *
 * GUARANTEES:
 *   - authz: requireCapability('schedule:access') — minimum capability for
 *     any scheduling read.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Never crosses org boundaries.
 *
 * TWO CALLING FORMS:
 *   listResources(session, opts?)          — app code; uses getDb() internally.
 *   listResourcesWithDb(db, session, opts) — tests; inject pglite client.
 */
import { asc, eq, or } from 'drizzle-orm';
import { resource } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';

// ─── Exported input / result types ───────────────────────────────────────────

export interface ListResourcesOptions {
  /**
   * includeInactive — when true, returns both active and inactive resources.
   * Default: false (active only).
   */
  includeInactive?: boolean;
}

/** Resource row shape returned by listResources. */
export interface ResourceRow {
  id: string;
  kind: string;
  displayName: string;
  tailNumber: string | null;
  instructorUserId: string | null;
  active: boolean;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _listResourcesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListResourcesOptions,
): Promise<ResourceRow[]> {
  // AUTHZ FIRST — before any data access.
  requireCapability(session, 'schedule:access');

  const includeInactive = opts?.includeInactive ?? false;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // RLS scopes rows to the session org; no explicit org_id predicate needed,
    // but withSessionOrgContextWithDb already sets the GUC so every query here
    // is RLS-scoped. We still apply the active filter in app code for clarity.
    const rows = await tx
      .select({
        id: resource.id,
        kind: resource.kind,
        displayName: resource.displayName,
        tailNumber: resource.tailNumber,
        instructorUserId: resource.instructorUserId,
        active: resource.active,
      })
      .from(resource)
      .where(includeInactive ? undefined : eq(resource.active, true))
      .orderBy(asc(resource.kind), asc(resource.displayName));

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      displayName: r.displayName,
      tailNumber: r.tailNumber ?? null,
      instructorUserId: r.instructorUserId ?? null,
      active: r.active,
    }));
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * listResources — return org-scoped resources for the authenticated session.
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param opts    - Optional filters: includeInactive (default false).
 * @returns ResourceRow[] ordered by kind then displayName.
 * @throws  UnauthenticatedError | ForbiddenError.
 */
export async function listResources(
  session: AppSession | null | undefined,
  opts?: ListResourcesOptions,
): Promise<ResourceRow[]> {
  const db = await getDb();
  return _listResourcesImpl(db, session, opts);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/** listResourcesWithDb — test form; inject a pglite client. */
export async function listResourcesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  opts?: ListResourcesOptions,
): Promise<ResourceRow[]> {
  return _listResourcesImpl(db, session, opts);
}
