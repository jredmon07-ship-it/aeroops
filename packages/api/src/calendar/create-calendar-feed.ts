/**
 * calendar/create-calendar-feed.ts — createCalendarFeed (Slice P1.4).
 *
 * Creates (or returns the existing ACTIVE) subscribable .ics feed for the
 * caller:
 *   scope='my_reservations' — self-scoped to session.userId. Gated on
 *     'app:access' (the broadest capability — every authenticated role has
 *     it) because this ONLY ever reads the caller's OWN reservations; there
 *     is no elevated-access surface to protect beyond "you must be logged in".
 *   scope='aircraft'        — gated on 'fleet:access' (the same capability
 *     that gates the Fleet detail page this is created from). resourceId is
 *     REQUIRED and validated to be an aircraft resource in the caller's org.
 *
 * ONE FEED PER (user, scope[, resource]): if an ACTIVE feed with the same
 * shape already exists for this caller, it is returned as-is (no new token
 * minted, no duplicate row) — "upsert or return existing". This is a
 * look-then-insert check (no DB-level natural-key UNIQUE — see migration
 * 0028 header) so a rapid double-click race could in principle create two
 * active feeds; low-severity (worst case: an extra unused, revocable feed
 * row), same posture as submitBookingRequest's documented best-effort rate
 * guard.
 *
 * GUARANTEES:
 *   - authz FIRST: requireCapability before any data access.
 *   - org_id + subject from session only (withSessionOrgContextWithDb).
 *   - feed_token generated via generateFeedToken() (node:crypto randomBytes
 *     → base64url, 256 bits) — NEVER caller-suppliable.
 *   - Audited 'calendar.feed_created'.
 *
 * TWO CALLING FORMS:
 *   createCalendarFeed(session, input)          — app code.
 *   createCalendarFeedWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { calendarFeed, resource, auditLog } from '@aeroops/db';
import type { AnyDb, CalendarFeedScope } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { generateFeedToken } from './internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createCalendarFeedInputSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('my_reservations') }),
  z.object({
    scope: z.literal('aircraft'),
    resourceId: z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
  }),
]);

export type CreateCalendarFeedInput = z.infer<typeof createCalendarFeedInputSchema>;

export interface CalendarFeedView {
  id: string;
  scope: CalendarFeedScope;
  resourceId: string | null;
  /** The opaque URL secret — ONLY ever returned from create/list/regenerate
   * (never logged, never echoed anywhere else). */
  feedToken: string;
  active: boolean;
  createdAt: Date;
}

export type CreateCalendarFeedResult =
  | { ok: true; feed: CalendarFeedView }
  | { ok: false; reason: 'not_found' };

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

async function _createCalendarFeedImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CreateCalendarFeedResult> {
  const parsed = createCalendarFeedInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[calendar] invalid createCalendarFeed input: ${first?.message ?? 'unknown'}`,
    );
  }
  const input = parsed.data;

  // AUTHZ FIRST — different capability per scope (see file header).
  if (input.scope === 'aircraft') {
    requireCapability(session, 'fleet:access');
  } else {
    requireCapability(session, 'app:access');
  }

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    let resourceId: string | null = null;

    if (input.scope === 'aircraft') {
      // The resource must exist in the caller's own org (RLS-scoped read;
      // org_id predicate is belt-and-suspenders on top of RLS).
      const resRows = await tx
        .select({ id: resource.id })
        .from(resource)
        .where(and(eq(resource.id, input.resourceId), eq(resource.orgId, sess.orgId)))
        .limit(1);
      if (!resRows[0]) {
        return { ok: false, reason: 'not_found' } as const;
      }
      resourceId = input.resourceId;
    }

    // One feed per (user, scope[, resource]) — return the existing ACTIVE
    // feed instead of minting a duplicate.
    const existing = await tx
      .select()
      .from(calendarFeed)
      .where(
        and(
          eq(calendarFeed.orgId, sess.orgId),
          eq(calendarFeed.userId, sess.userId),
          eq(calendarFeed.scope, input.scope),
          eq(calendarFeed.active, true),
          resourceId ? eq(calendarFeed.resourceId, resourceId) : isNull(calendarFeed.resourceId),
        ),
      )
      .limit(1);

    if (existing[0]) {
      return { ok: true, feed: toView(existing[0]) } as const;
    }

    const inserted = await tx
      .insert(calendarFeed)
      .values({
        orgId: sess.orgId,
        userId: sess.userId,
        scope: input.scope,
        resourceId,
        feedToken: generateFeedToken(),
        active: true,
      })
      .returning();

    const row = inserted[0];
    if (!row) throw new Error('[calendar] createCalendarFeed: insert returned no row');

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'calendar.feed_created',
      entityType: 'calendar_feed',
      entityId: row.id,
      metadata: { scope: row.scope, resourceId: row.resourceId },
    });

    return { ok: true, feed: toView(row) } as const;
  });
}

export async function createCalendarFeed(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateCalendarFeedResult> {
  const db = await getDb();
  return _createCalendarFeedImpl(db, session, input);
}

export async function createCalendarFeedWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateCalendarFeedResult> {
  return _createCalendarFeedImpl(db, session, input);
}
