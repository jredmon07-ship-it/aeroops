/**
 * notifications/send-notification.ts — sendNotification (Slice P1.3).
 *
 * THE dispatcher every hook calls. BEST-EFFORT, NEVER THROWS: wraps its
 * entire body in a try/catch so a notification failure can never break the
 * core action that triggered it (mirrors demo/reset.ts's
 * maybeResetDemoTenant — the house pattern for "best-effort, error-
 * swallowed side effect after a core action has already committed").
 *
 * FLOW:
 *   1. Resolve the recipient (app_user row for input.toUserId, scoped by
 *      session.orgId via RLS). Not found → log nothing, return silently
 *      (there is no org-scoped row to attach a notification_log entry to).
 *   2. Resolve the pref: notification_pref WHERE (org_id, user_id,
 *      event_type). No row → enabled (default opt-IN). email_enabled=false
 *      → write ONE 'skipped' notification_log row, do not call the
 *      provider, return.
 *   3. Render the template (pure, see templates.ts).
 *   4. Call the provider (getEmailProvider()). Success → 'sent' log row.
 *      Failure (provider throws) → 'failed' log row with error_detail (the
 *      provider error's message ONLY — never the email body).
 *
 * PRIVACY: notification_log NEVER stores the rendered html/text body —
 * only to_email + subject (see migration 0026 header).
 *
 * CALLING CONTEXT: called from the WEB ACTION LAYER, AFTER the triggering
 * command's own transaction has already committed (external I/O, including
 * this DB write, must never be held inside the core command's own tx). Opens its OWN fresh
 * withSessionOrgContext(WithDb) scope.
 *
 * TWO CALLING FORMS:
 *   sendNotification(session, input)          — app code; uses getDb() internally.
 *   sendNotificationWithDb(db, session, input) — tests; inject pglite client.
 */
import { eq, and } from 'drizzle-orm';
import { appUser, notificationLog, notificationPref } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { getEmailProvider } from './email-provider.js';
import type { EmailProvider } from './email-provider.js';
import { renderNotificationTemplate } from './templates.js';
import type { NotificationEventType, NotificationTemplateDataMap } from './email-event-types.js';

export interface SendNotificationInput<E extends NotificationEventType = NotificationEventType> {
  /** The recipient — an app_user id in the caller's org. */
  toUserId: string;
  eventType: E;
  templateData: NotificationTemplateDataMap[E];
}

export type SendNotificationResult =
  | { sent: true }
  | {
      sent: false;
      reason: 'recipient_not_found' | 'opted_out' | 'provider_error' | 'internal_error';
    };

async function _sendNotificationImpl<E extends NotificationEventType>(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: SendNotificationInput<E>,
  provider: EmailProvider,
): Promise<SendNotificationResult> {
  try {
    return await withSessionOrgContextWithDb(db, session, async (sess, tx) => {
      // 1. Resolve the recipient — RLS-scoped read, org-safe by construction.
      const recipientRows = await tx
        .select({ id: appUser.id, email: appUser.email })
        .from(appUser)
        .where(eq(appUser.id, input.toUserId))
        .limit(1);
      const recipient = recipientRows[0];
      if (!recipient) {
        return { sent: false, reason: 'recipient_not_found' } as const;
      }

      // 2. Resolve the pref — absence of a row means enabled (default opt-IN).
      const prefRows = await tx
        .select({ emailEnabled: notificationPref.emailEnabled })
        .from(notificationPref)
        .where(
          and(
            eq(notificationPref.userId, input.toUserId),
            eq(notificationPref.eventType, input.eventType),
          ),
        )
        .limit(1);
      const enabled = prefRows[0]?.emailEnabled ?? true;

      // 3. Render (pure — no I/O).
      const rendered = renderNotificationTemplate(input.eventType, input.templateData);

      if (!enabled) {
        await tx.insert(notificationLog).values({
          orgId: sess.orgId,
          userId: input.toUserId,
          channel: 'email',
          eventType: input.eventType,
          toEmail: recipient.email,
          subject: rendered.subject,
          status: 'skipped',
          errorDetail: null,
        });
        return { sent: false, reason: 'opted_out' } as const;
      }

      // 4. Call the provider. NEVER let a provider failure escape as an
      //    unhandled rejection — record 'failed' and return a typed result.
      try {
        await provider.send({
          to: recipient.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });
        await tx.insert(notificationLog).values({
          orgId: sess.orgId,
          userId: input.toUserId,
          channel: 'email',
          eventType: input.eventType,
          toEmail: recipient.email,
          subject: rendered.subject,
          status: 'sent',
          errorDetail: null,
        });
        return { sent: true } as const;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown provider error';
        await tx.insert(notificationLog).values({
          orgId: sess.orgId,
          userId: input.toUserId,
          channel: 'email',
          eventType: input.eventType,
          toEmail: recipient.email,
          subject: rendered.subject,
          status: 'failed',
          errorDetail: message,
        });
        return { sent: false, reason: 'provider_error' } as const;
      }
    });
  } catch (err) {
    // NEVER throw to the caller — this is a best-effort side effect (mirrors
    // maybeResetDemoTenant). Log server-side for ops visibility only; NO
    // email body, NO PII beyond what would already be in a stack trace.
    // eslint-disable-next-line no-console
    console.error('[notifications] sendNotification failed unexpectedly', err);
    return { sent: false, reason: 'internal_error' };
  }
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function sendNotification<E extends NotificationEventType>(
  session: AppSession | null | undefined,
  input: SendNotificationInput<E>,
): Promise<SendNotificationResult> {
  let db: AnyDb;
  try {
    db = await getDb();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notifications] sendNotification: could not obtain db client', err);
    return { sent: false, reason: 'internal_error' };
  }
  return _sendNotificationImpl(db, session, input, getEmailProvider());
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function sendNotificationWithDb<E extends NotificationEventType>(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: SendNotificationInput<E>,
  provider: EmailProvider = getEmailProvider(),
): Promise<SendNotificationResult> {
  return _sendNotificationImpl(db, session, input, provider);
}
