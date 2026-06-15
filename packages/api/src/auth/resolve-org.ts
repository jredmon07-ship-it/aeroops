/**
 * resolve-org.ts — Platform-scoped org lookup by slug (auth path only).
 *
 * SANCTIONED PLATFORM-ADMIN READ:
 *   resolveOrgBySlug is the ONLY function in the auth path that is
 *   permitted to use withPlatformAdminContext. It is:
 *     - Read-only (SELECT only — no mutation).
 *     - Single-row result with a FIXED projection {id, name, slug, status}.
 *     - Keyed by exact slug match (UNIQUE constraint on org.slug).
 *     - Called exclusively during login, before any session exists.
 *
 *   All other tenant reads in the auth path use withOrgContext (the
 *   normal per-tenant choke-point). withPlatformAdminContext must NOT
 *   be used anywhere else in packages/api.
 *
 * The caller (auth-config.ts → buildAuthConfig) must:
 *   1. Check result !== null.
 *   2. Check result.status === 'active' before proceeding.
 *   3. Pass result.id as orgId into verifyCredential (withOrgContext).
 *
 * This function is framework-agnostic; it does not import next-auth.
 */
import { eq } from 'drizzle-orm';
import { withPlatformAdminContext } from '@aeroops/db';
import { org } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';

/**
 * The fixed projection returned by resolveOrgBySlug.
 * Only {id, name, slug, status} are exposed — no internal timestamps or other
 * control-plane fields leak into the auth surface.
 *
 * `name` is included so the login page can display "Sign in to {org.name}"
 * without a second DB round-trip or a separate lookup function.
 */
export interface ResolvedOrg {
  id: string;
  name: string;
  slug: string;
  status: string;
}

/**
 * resolveOrgBySlug — looks up an org by its URL slug.
 *
 * Uses withPlatformAdminContext because the org table's SELECT policy
 * requires either a matching app.current_org_id OR platform-admin context.
 * At login time we have neither (no session yet), so platform-admin is the
 * only valid path. The read is strictly limited to the three fields needed
 * to continue the login flow.
 *
 * Returns null if no org with the given slug exists.
 *
 * @param db   - The Drizzle database client (prod or test).
 * @param slug - The org's URL slug (e.g. "alpha-flight-school").
 */
export async function resolveOrgBySlug(
  db: AnyDb,
  slug: string,
): Promise<ResolvedOrg | null> {
  const rows = await withPlatformAdminContext(db, (tx) =>
    tx
      .select({ id: org.id, name: org.name, slug: org.slug, status: org.status })
      .from(org)
      .where(eq(org.slug, slug))
      .limit(1),
  );

  return rows[0] ?? null;
}
