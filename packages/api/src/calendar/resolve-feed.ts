/**
 * calendar/resolve-feed.ts — platform-scoped feed-token → org/user/scope
 * lookup (the public .ics route path only, Slice P1.4).
 *
 * SANCTIONED PLATFORM-ADMIN READ (mirrors auth/resolve-org.ts's
 * resolveOrgBySlug / integrations/stripe/resolve-payment-intent.ts's
 * resolveOrgByStripePaymentIntentId EXACTLY — same justification, a
 * DIFFERENT unauthenticated entry point):
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
 * This function is framework-agnostic; it does not import next/*.
 */
import { eq } from 'drizzle-orm';
import { withPlatformAdminContext, calendarFeed } from '@aeroops/db';
import type { AnyDb, CalendarFeedScope } from '@aeroops/db';

export interface ResolvedCalendarFeed {
  id: string;
  orgId: string;
  userId: string;
  scope: CalendarFeedScope;
  resourceId: string | null;
}

/**
 * resolveFeedByToken — looks up a calendar feed by its opaque URL token.
 *
 * Returns null if:
 *   - no row has this feed_token (unknown token), OR
 *   - the row exists but active=false (revoked).
 * Both cases are INDISTINGUISHABLE to the caller — anti-enumeration.
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

  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    scope: row.scope as CalendarFeedScope,
    resourceId: row.resourceId,
  };
}
