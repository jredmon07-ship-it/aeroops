/**
 * lib/demo-login.ts — "is there a demo org on THIS server?" for public pages.
 *
 * The /signup page used to link to the sample operations' sign-in pages
 * unconditionally. On a self-hosted copy those orgs do not exist, so the links
 * 404'd. findActiveOrgLoginHref returns the sign-in href only when the org
 * exists AND is active on this deployment.
 *
 * No enumeration: unknown and suspended orgs both return null (the caller
 * cannot tell them apart), and a resolver failure (e.g. DB down) also returns
 * null so a public page never 500s over an optional link.
 *
 * The resolver is injected (the page passes resolveOrgForPage from lib/org)
 * so this module has no @aeroops/api import and is unit-testable without a DB.
 */

/** The subset of ResolvedOrg this helper reads. */
export interface OrgStatusLike {
  slug: string;
  status: string;
}

/** Pure: the sign-in href for an active org, else null. */
export function loginHrefForActiveOrg(org: OrgStatusLike | null): string | null {
  if (!org || org.status !== 'active') return null;
  return `/o/${encodeURIComponent(org.slug)}/login`;
}

/** Resolves `slug` and returns its sign-in href, or null if unknown/suspended/unreachable. */
export async function findActiveOrgLoginHref(
  slug: string,
  resolve: (slug: string) => Promise<OrgStatusLike | null>,
): Promise<string | null> {
  try {
    return loginHrefForActiveOrg(await resolve(slug));
  } catch {
    return null;
  }
}
