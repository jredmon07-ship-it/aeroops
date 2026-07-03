/**
 * calendar/build-ics-for-feed.ts — renders a resolved calendar feed's
 * reservations into an RFC-5545 .ics document (Slice P1.4).
 *
 * Called ONLY with the output of resolveFeedByToken (never with caller-
 * supplied org/user/resource ids) — see apps/web/app/api/calendar/[token]/
 * route.ts. Every reservation read happens inside withOrgContext(feed.orgId,
 * ...): the normal per-tenant choke-point, using the org_id resolveFeedByToken
 * resolved from OUR OWN calendar_feed row — never platform-admin context.
 *
 * WINDOW: a rolling [now-7d, now+90d) window — recent history + the near
 * future, matching a calendar app's typical "show me what's coming up (and
 * what just happened)" subscription use case. Not caller-configurable (there
 * is no query-string input on the public route at all).
 */
import { sql } from 'drizzle-orm';
import { withOrgContext } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { buildIcs } from '@aeroops/core';
import type { IcsEvent } from '@aeroops/core';
import type { ResolvedCalendarFeed } from './resolve-feed.js';
import {
  readCalendarEventsForUser,
  readCalendarEventsForResource,
} from './internal.js';
import type { CalendarEventRow } from './internal.js';

const WINDOW_PAST_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days back
const WINDOW_FUTURE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days forward

function toIcsEvent(row: CalendarEventRow, scope: ResolvedCalendarFeed['scope']): IcsEvent {
  return {
    // Stable per-reservation UID: a calendar app recognizes the SAME
    // reservation across re-fetches (updates in place) instead of
    // duplicating it, and never collides across orgs (reservation ids are
    // globally-random uuids).
    uid: `aeroops-reservation-${row.id}@aeroops.app`,
    start: row.startAt,
    end: row.endAt,
    summary:
      scope === 'aircraft'
        ? `${row.resourceLabel} — Reserved`
        : `Reservation — ${row.resourceLabel}`,
    description: row.notes ?? undefined,
  };
}

/**
 * buildIcsForFeed — reads the feed's reservations (self-scoped for
 * 'my_reservations', per-tail for 'aircraft') and serializes them to .ics.
 *
 * @param db   - The Drizzle database client (prod or test).
 * @param feed - The ALREADY-RESOLVED feed (from resolveFeedByToken) — orgId/
 *               userId/scope/resourceId all come from OUR OWN table, never
 *               from caller input.
 * @param now  - Injected clock for DTSTAMP + the window anchor (defaults to
 *               `new Date()`; tests pass a fixed value for determinism).
 */
export async function buildIcsForFeed(
  db: AnyDb,
  feed: ResolvedCalendarFeed,
  now: Date = new Date(),
): Promise<string> {
  const from = new Date(now.getTime() - WINDOW_PAST_MS);
  const to = new Date(now.getTime() + WINDOW_FUTURE_MS);

  if (feed.scope === 'aircraft' && !feed.resourceId) {
    // Unreachable given calendar_feed_scope_shape_check — fail loudly rather
    // than silently mis-reading as a 'my_reservations' feed.
    throw new Error('[calendar] aircraft-scoped feed has no resourceId (DB invariant violated)');
  }

  const rows = await withOrgContext(db, feed.orgId, async (tx) => {
    return feed.scope === 'aircraft'
      ? readCalendarEventsForResource(tx as AnyDb, feed.resourceId!, from, to)
      : readCalendarEventsForUser(tx as AnyDb, feed.userId, from, to);
  });

  // Best-effort last_accessed_at bump — a failure here must NEVER break the
  // calendar response (a calendar app's GET should always get its .ics; the
  // access timestamp is informational only). Deliberately its OWN
  // withOrgContext call, separate from the read above, so a bump failure
  // cannot roll back (or be rolled back by) the read.
  try {
    await withOrgContext(db, feed.orgId, async (tx) => {
      await (tx as AnyDb).execute(
        sql`UPDATE calendar_feed SET last_accessed_at = now() WHERE id = ${feed.id}::uuid`,
      );
    });
  } catch {
    // Swallow — best-effort only.
  }

  const events = rows.map((r) => toIcsEvent(r, feed.scope));

  return buildIcs(events, {
    now,
    calendarName: feed.scope === 'aircraft' ? 'Aircraft Schedule' : 'My AeroOps Reservations',
  });
}
