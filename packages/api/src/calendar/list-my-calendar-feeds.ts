/**
 * calendar/list-my-calendar-feeds.ts — listMyCalendarFeeds (Slice P1.4).
 *
 * SELF-SCOPED (app:access): returns ONLY the caller's OWN calendar-feed
 * rows (active and revoked — the UI needs both to render "Revoked" history/
 * offer regenerate). subject = session.userId ONLY; there is no userId
 * input parameter — self-scoping is by construction, same pattern as every
 * portal/* self-scoped read.
 *
 * GUARANTEES:
 *   - authz FIRST: app:access before any data access.
 *   - org_id + subject from session only (withSessionOrgContextWithDb).
 *   - Read-only (not audited — mirrors getMyReservations).
 *
 * TWO CALLING FORMS:
 *   listMyCalendarFeeds(session)          — app code.
 *   listMyCalendarFeedsWithDb(db, session) — tests.
 */
import { and, desc, eq } from 'drizzle-orm';
import { calendarFeed } from '@aeroops/db';
import type { AnyDb, CalendarFeedScope } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type { CalendarFeedView } from './create-calendar-feed.js';

function toView(row: typeof calendarFeed.$inferSelect): CalendarFeedView {
  return {
    id: row.id,
    scope: row.scope as CalendarFeedScope,
    resourceId: row.resourceId,
    feedToken: row.feedToken,
    active: row.active,
    createdAt: row.createdAt,
  };
}

async function _listMyCalendarFeedsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<CalendarFeedView[]> {
  requireCapability(session, 'app:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // SELF-SCOPED: sess.userId only — never a caller-supplied id.
    const rows = await tx
      .select()
      .from(calendarFeed)
      .where(and(eq(calendarFeed.orgId, sess.orgId), eq(calendarFeed.userId, sess.userId)))
      .orderBy(desc(calendarFeed.createdAt));
    return rows.map(toView);
  });
}

export async function listMyCalendarFeeds(
  session: AppSession | null | undefined,
): Promise<CalendarFeedView[]> {
  const db = await getDb();
  return _listMyCalendarFeedsImpl(db, session);
}

export async function listMyCalendarFeedsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<CalendarFeedView[]> {
  return _listMyCalendarFeedsImpl(db, session);
}
