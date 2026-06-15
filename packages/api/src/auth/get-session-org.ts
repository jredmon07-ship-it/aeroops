/**
 * get-session-org.ts — Fetch the current org's display data for the session.
 *
 * Called from apps/web server components/actions that need to display the
 * org name in the authenticated app shell. Uses withSessionOrgContext so the
 * DB query is always tenant-scoped (RLS enforced).
 *
 * Returns null if the org row cannot be found (should not happen in normal
 * operation — if the session is valid, the org exists — but guards gracefully
 * in case of a race between session validity and org deletion).
 */
import { eq } from 'drizzle-orm';
import { org } from '@aeroops/db';
import { withOrgContext } from '@aeroops/db';
import { getDb } from '../db.js';
import type { AppSession } from './types.js';
import { UnauthenticatedError } from './session.js';

export interface SessionOrgData {
  id: string;
  name: string;
  slug: string;
  status: string;
}

/**
 * getSessionOrg — returns {id, name, slug, status} for the session's org.
 *
 * The org_id is always taken from the session (JWT-bound, tamper-proof) —
 * never from the URL or client input.
 *
 * @param session - AppSession from auth(); may be null/undefined (throws).
 * @throws UnauthenticatedError if the session is null/undefined/incomplete.
 */
export async function getSessionOrg(
  session: AppSession | null | undefined,
): Promise<SessionOrgData | null> {
  if (!session || !session.orgId) {
    throw new UnauthenticatedError(
      '[getSessionOrg] No authenticated session.',
    );
  }

  const db = await getDb();
  const rows = await withOrgContext(db, session.orgId, (tx) =>
    tx
      .select({
        id: org.id,
        name: org.name,
        slug: org.slug,
        status: org.status,
      })
      .from(org)
      .where(eq(org.id, session.orgId))
      .limit(1),
  );

  return rows[0] ?? null;
}
