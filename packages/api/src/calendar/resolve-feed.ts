/**
 * calendar/resolve-feed.ts — platform-scoped feed-token → org/user/scope
 * lookup (the public .ics route path only, Slice P1.4).
 *
 * SANCTIONED PLATFORM-ADMIN READ (mirrors auth/resolve-org.ts's
 * resolveOrgBySlug EXACTLY — same justification, a DIFFERENT
 * unauthenticated entry point):
 *   resolveFeedByToken is the ONLY function in the public calendar-feed path
 *   that is permitted to use withPlatformAdminContext. It is:
 *     - Read-only (SELECT only — no mutation).
 *     - Single-row result with a FIXED projection {id, orgId, userId, scope,
 *       resourceId}.
 *     - Keyed by exact match on feed_token (globally UNIQUE —
 *       calendar_feed_token_unique, migration 0028).
 *     - Called exclusively from the public .ics route
 *       (apps/web/app/api/calendar/[token]/route.ts), BEFORE any org context
 *       can be established (a calendar app's periodic GET carries no
 *       AeroOps session — the token IS the only handle we have to find
 *       which org+user a feed belongs to).
 *
 *   Every subsequent read (buildIcsForFeed's reservation reads) and the
 *   last_accessed_at write happen ONLY inside withOrgContext(db,
 *   resolvedOrgId, ...) — the normal per-tenant choke-point — using the
 *   org_id THIS function resolved from OUR OWN table, never from anywhere
 *   client-suppliable.
 *
 * ANTI-ENUMERATION: an unknown token AND an inactive (revoked) token both
 * return null — the caller (the web route) must map both to the SAME
 * generic 404, so a prober cannot distinguish "never existed" from
 * "revoked" by response shape/timing signal.
 *
 * OWNER RE-CHECK: the capability is checked when a feed is CREATED
 * (create-calendar-feed.ts), but a feed URL is a long-lived credential, so
 * every fetch also re-checks the feed's owner — the same facts a signed-in
 * session is re-checked against (auth/session-revalidation.ts) — under
 * withOrgContext(the resolved org), NOT platform-admin:
 *   no membership in the feed's org (removed)        → null
 *   org not active (suspended)                       → null
 *   the role can no longer create this scope of feed → null
 *     ('aircraft' needs fleet:access: the feed serves every booking on the
 *      tail, notes included, so a mechanic demoted to renter loses it;
 *      'my_reservations' needs app:access)
 * The same null as an unknown token, so the route's 404 stays generic. The
 * feed row is untouched: restoring the member, the org or the role brings it
 * back. A password reset does NOT revoke feeds (a feed URL is not a sign-in;
 * the member revokes or regenerates it from the Portal or the aircraft's
 * Fleet page) — see docs/specs/login-links.md.
 *
 * This function is framework-agnostic; it does not import next/*.
 */
import { and, eq } from 'drizzle-orm';
import { withOrgContext, withPlatformAdminContext, calendarFeed, membership, org } from '@aeroops/db';
import type { AnyDb, CalendarFeedScope } from '@aeroops/db';
import { can } from '@aeroops/core';

export interface ResolvedCalendarFeed {
  id: string;
  orgId: string;
  userId: string;
  scope: CalendarFeedScope;
  resourceId: string | null;
}

/**
 * ownerCanStillRead — the OWNER RE-CHECK (see header): one RLS-scoped read of
 * the owner's membership role and the org's status, under the feed's own org.
 */
async function ownerCanStillRead(db: AnyDb, feed: ResolvedCalendarFeed): Promise<boolean> {
  const rows = await withOrgContext(db, feed.orgId, (tx) =>
    tx
      .select({ role: membership.role, orgStatus: org.status })
      .from(membership)
      .innerJoin(org, eq(org.id, membership.orgId))
      .where(and(eq(membership.orgId, feed.orgId), eq(membership.userId, feed.userId)))
      .limit(1),
  );
  const row = rows[0];
  if (!row || row.orgStatus !== 'active') return false;
  return can(row.role, feed.scope === 'aircraft' ? 'fleet:access' : 'app:access');
}

/**
 * resolveFeedByToken — looks up a calendar feed by its opaque URL token.
 *
 * Returns null if:
 *   - no row has this feed_token (unknown token), OR
 *   - the row exists but active=false (revoked), OR
 *   - its owner can no longer read it (OWNER RE-CHECK in the header).
 * All are INDISTINGUISHABLE to the caller — anti-enumeration.
 *
 * @param db    - The Drizzle database client (prod or test).
 * @param token - The opaque feed_token from the URL path segment.
 */
export async function resolveFeedByToken(
  db: AnyDb,
  token: string,
): Promise<ResolvedCalendarFeed | null> {
  const rows = await withPlatformAdminContext(db, (tx) =>
    tx
      .select({
        id: calendarFeed.id,
        orgId: calendarFeed.orgId,
        userId: calendarFeed.userId,
        scope: calendarFeed.scope,
        resourceId: calendarFeed.resourceId,
        active: calendarFeed.active,
      })
      .from(calendarFeed)
      .where(eq(calendarFeed.feedToken, token))
      .limit(1),
  );

  const row = rows[0];
  if (!row || !row.active) return null;

  const feed: ResolvedCalendarFeed = {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    scope: row.scope as CalendarFeedScope,
    resourceId: row.resourceId,
  };
  return (await ownerCanStillRead(db, feed)) ? feed : null;
}
