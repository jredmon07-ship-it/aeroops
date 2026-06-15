/**
 * lib/org.ts — Thin server-side helpers for org resolution.
 *
 * Only imports from @aeroops/api — never @aeroops/db.
 *
 * resolveOrgForPage is used by login, no-access, and other public-facing
 * pages that need org metadata (name, status) without a session.
 * It delegates to resolveOrgBySlug which uses withPlatformAdminContext
 * (the sanctioned, read-only path for slug lookups at auth time).
 */
import { getDb, resolveOrgBySlug } from '@aeroops/api';
import type { ResolvedOrg } from '@aeroops/api';

export type { ResolvedOrg };

/**
 * resolveOrgForPage — resolves org metadata for a page render.
 *
 * Returns null if no org exists with the given slug (triggers "unknown org"
 * terminal state on the login page).
 *
 * Throws if the DB is unavailable (infrastructure error — Next.js will
 * surface a 500 error page, which is correct for infra failures).
 */
export async function resolveOrgForPage(
  slug: string,
): Promise<ResolvedOrg | null> {
  const db = await getDb();
  return resolveOrgBySlug(db, slug);
}
