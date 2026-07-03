/**
 * calendar/revoke-calendar-feed.ts — revokeCalendarFeed +
 * regenerateCalendarFeed (Slice P1.4).
 *
 * SELF-SCOPED (app:access): both operate ONLY on a feed row that matches
 * (id, org_id=session.orgId, user_id=session.userId) — a member can NEVER
 * revoke/regenerate another member's feed, even within the same org (the
 * WHERE clause enforces this structurally, not just by capability). An
 * unmatched feedId (wrong owner, wrong org, or nonexistent) returns the
 * SAME { ok:false, reason:'not_found' } in every case — no enumeration of
 * "exists but isn't yours" vs "doesn't exist".
 *
 * revokeCalendarFeed: sets active=false. The row (and its now-dead token)
 *   stays for audit history — resolveFeedByToken already treats
 *   active=false as "not found" (anti-enumeration on the .ics route side).
 *
 * regenerateCalendarFeed: ATOMIC revoke-old + create-new in ONE tx (same
 *   scope/resource as the old row) — a fresh feed_token, so the old URL
 *   stops working the instant the new one starts. THE OLD TOKEN'S ROW STAYS
 *   REVOKED (not deleted) for audit history, same as a plain revoke.
 *
 * GUARANTEES:
 *   - authz FIRST: app:access before any data access.
 *   - org_id + subject from session only (withSessionOrgContextWithDb).
 *   - Audited 'calendar.feed_revoked' / 'calendar.feed_created'.
 *
 * FOUR CALLING FORMS (two ops x app-code/test):
 *   revokeCalendarFeed(session, input)              — app code.
 *   revokeCalendarFeedWithDb(db, session, input)     — tests.
 *   regenerateCalendarFeed(session, input)           — app code.
 *   regenerateCalendarFeedWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { calendarFeed, auditLog } from '@aeroops/db';
import type { AnyDb, CalendarFeedScope } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { generateFeedToken } from './internal.js';
import type { CalendarFeedView } from './create-calendar-feed.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const feedIdInputSchema = z.object({
  feedId: z.string().regex(UUID_RE, { message: 'feedId must be a UUID' }),
});

export type RevokeCalendarFeedInput = z.infer<typeof feedIdInputSchema>;
export type RegenerateCalendarFeedInput = z.infer<typeof feedIdInputSchema>;

export type RevokeCalendarFeedResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' };

export type RegenerateCalendarFeedResult =
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

function parseFeedIdInput(rawInput: unknown, label: string): RevokeCalendarFeedInput {
  const parsed = feedIdInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[calendar] invalid ${label} input: ${first?.message ?? 'unknown'}`);
  }
  return parsed.data;
}

// ─── revokeCalendarFeed ────────────────────────────────────────────────────────

async function _revokeCalendarFeedImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<RevokeCalendarFeedResult> {
  const { feedId } = parseFeedIdInput(rawInput, 'revokeCalendarFeed');
  requireCapability(session, 'app:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // SELF-OWNED: id + org_id + user_id must ALL match.
    const updated = await tx
      .update(calendarFeed)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(calendarFeed.id, feedId),
          eq(calendarFeed.orgId, sess.orgId),
          eq(calendarFeed.userId, sess.userId),
        ),
      )
      .returning();

    const row = updated[0];
    if (!row) return { ok: false, reason: 'not_found' } as const;

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'calendar.feed_revoked',
      entityType: 'calendar_feed',
      entityId: row.id,
      metadata: { scope: row.scope, resourceId: row.resourceId },
    });

    return { ok: true } as const;
  });
}

export async function revokeCalendarFeed(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<RevokeCalendarFeedResult> {
  const db = await getDb();
  return _revokeCalendarFeedImpl(db, session, input);
}

export async function revokeCalendarFeedWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<RevokeCalendarFeedResult> {
  return _revokeCalendarFeedImpl(db, session, input);
}

// ─── regenerateCalendarFeed ─────────────────────────────────────────────────────

async function _regenerateCalendarFeedImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<RegenerateCalendarFeedResult> {
  const { feedId } = parseFeedIdInput(rawInput, 'regenerateCalendarFeed');
  requireCapability(session, 'app:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // SELF-OWNED lookup: id + org_id + user_id must ALL match.
    const existingRows = await tx
      .select()
      .from(calendarFeed)
      .where(
        and(
          eq(calendarFeed.id, feedId),
          eq(calendarFeed.orgId, sess.orgId),
          eq(calendarFeed.userId, sess.userId),
        ),
      )
      .limit(1);

    const existing = existingRows[0];
    if (!existing) return { ok: false, reason: 'not_found' } as const;

    // ── Revoke the old row ────────────────────────────────────────────────
    await tx
      .update(calendarFeed)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(calendarFeed.id, existing.id));

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'calendar.feed_revoked',
      entityType: 'calendar_feed',
      entityId: existing.id,
      metadata: { scope: existing.scope, resourceId: existing.resourceId, reason: 'regenerate' },
    });

    // ── Create the new row (same scope/resource, a fresh token) ──────────
    const inserted = await tx
      .insert(calendarFeed)
      .values({
        orgId: sess.orgId,
        userId: sess.userId,
        scope: existing.scope,
        resourceId: existing.resourceId,
        feedToken: generateFeedToken(),
        active: true,
      })
      .returning();

    const row = inserted[0];
    if (!row) throw new Error('[calendar] regenerateCalendarFeed: insert returned no row');

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'calendar.feed_created',
      entityType: 'calendar_feed',
      entityId: row.id,
      metadata: { scope: row.scope, resourceId: row.resourceId, reason: 'regenerate' },
    });

    return { ok: true, feed: toView(row) } as const;
  });
}

export async function regenerateCalendarFeed(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<RegenerateCalendarFeedResult> {
  const db = await getDb();
  return _regenerateCalendarFeedImpl(db, session, input);
}

export async function regenerateCalendarFeedWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<RegenerateCalendarFeedResult> {
  return _regenerateCalendarFeedImpl(db, session, input);
}
