/**
 * notifications/prefs.ts — getMyNotificationPrefs / setMyNotificationPref
 * (Slice P1.3).
 *
 * SELF-SCOPED, like portal/*: no userId parameter is ever accepted — the
 * subject is ALWAYS session.userId from the verified session. Gated on
 * 'app:access' only (every role holds it) — notification preferences are
 * inherently personal and apply regardless of role (a dispatcher or CFI can
 * be the recipient of a squawk/grounding self-notification just as much as
 * an owner or member).
 *
 * getMyNotificationPrefs returns ONE row per NOTIFICATION_EVENT_TYPES entry
 * (defaulting emailEnabled:true when no notification_pref row exists yet) —
 * the UI always has a complete, stable list to render toggles for.
 *
 * TWO CALLING FORMS per command:
 *   fn(session, input)          — app code.
 *   fnWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { notificationPref } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { NOTIFICATION_EVENT_TYPES, isNotificationEventType } from './email-event-types.js';
import type { NotificationEventType } from './email-event-types.js';

export interface NotificationPrefView {
  eventType: NotificationEventType;
  emailEnabled: boolean;
}

// ─── getMyNotificationPrefs ───────────────────────────────────────────────────

async function _getMyNotificationPrefsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<NotificationPrefView[]> {
  const sess = requireCapability(session, 'app:access');

  return withSessionOrgContextWithDb(db, session, async (_s, tx) => {
    const rows = await tx
      .select({ eventType: notificationPref.eventType, emailEnabled: notificationPref.emailEnabled })
      .from(notificationPref)
      .where(eq(notificationPref.userId, sess.userId));

    const overrides = new Map<string, boolean>();
    for (const row of rows) {
      overrides.set(row.eventType, row.emailEnabled);
    }

    // Always return the full, stable event-type list — default enabled when
    // no override row exists (absence-means-enabled, per migration 0026).
    return NOTIFICATION_EVENT_TYPES.map((eventType) => ({
      eventType,
      emailEnabled: overrides.get(eventType) ?? true,
    }));
  });
}

export async function getMyNotificationPrefs(
  session: AppSession | null | undefined,
): Promise<NotificationPrefView[]> {
  const db = await getDb();
  return _getMyNotificationPrefsImpl(db, session);
}

export async function getMyNotificationPrefsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<NotificationPrefView[]> {
  return _getMyNotificationPrefsImpl(db, session);
}

// ─── setMyNotificationPref ────────────────────────────────────────────────────

const setMyNotificationPrefInputSchema = z.object({
  eventType: z.string().refine(isNotificationEventType, { message: 'unknown eventType' }),
  emailEnabled: z.boolean(),
});

export type SetMyNotificationPrefResult = { ok: true; pref: NotificationPrefView };

async function _setMyNotificationPrefImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetMyNotificationPrefResult> {
  const sess = requireCapability(session, 'app:access');

  const parsed = setMyNotificationPrefInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[notifications] invalid setMyNotificationPref input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { eventType, emailEnabled } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_s, tx) => {
    // Upsert — the UNIQUE (org_id, user_id, event_type) constraint (migration
    // 0026) is the target. Self-scoped: userId is ALWAYS sess.userId, never
    // caller-suppliable.
    await tx
      .insert(notificationPref)
      .values({
        orgId: sess.orgId,
        userId: sess.userId,
        eventType,
        emailEnabled,
      })
      .onConflictDoUpdate({
        target: [notificationPref.orgId, notificationPref.userId, notificationPref.eventType],
        set: { emailEnabled, updatedAt: new Date() },
      });

    return { ok: true, pref: { eventType, emailEnabled } } as const;
  });
}

export async function setMyNotificationPref(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SetMyNotificationPrefResult> {
  const db = await getDb();
  return _setMyNotificationPrefImpl(db, session, input);
}

export async function setMyNotificationPrefWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SetMyNotificationPrefResult> {
  return _setMyNotificationPrefImpl(db, session, input);
}
