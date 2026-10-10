/**
 * notifications/send-member-message.ts — sendMemberMessage /
 * previewMemberMessageRecipients / listMemberMessages (Slice FC-P1: member
 * messaging / announcements — FC-parity "Engage with Messaging by Email").
 *
 * An operator (owner/manager) composes a one-off announcement (subject +
 * plain-text body) and sends it to either every active member, or every
 * active member holding one role. This is the first OPERATOR-AUTHORED
 * broadcast surface — existing notifications (Slice P1.3) are all
 * system-triggered, per-event, single-recipient.
 *
 * FLOW (sendMemberMessage):
 *   1. requireCapability('org:manage_settings') FIRST — owner/manager only.
 *   2. Validate input (zod): subject/body non-empty + length-capped; audience
 *      IN ('all_active','role'); role REQUIRED iff audience='role' and a
 *      valid MembershipRole.
 *   3. ONE org-scoped tx: resolve recipients (active members, optionally
 *      role-filtered) + the org's display name, INSERT ONE member_message
 *      row (recipient_count = recipients.length), ONE audit_log row
 *      ('org.announcement_sent' — metadata carries subject/audience/role/
 *      recipientCount, NEVER the body).
 *   4. AFTER that tx commits: best-effort fan-out, ONE sendNotification call
 *      per recipient (event type 'org.announcement') — mirrors
 *      notifyMaintenanceDue's calling convention exactly (each call opens
 *      its OWN fresh org-context scope; one recipient's failure/opt-out
 *      never blocks another's send).
 *
 * PRIVACY / COMPLIANCE:
 *   - body is PLAIN TEXT ONLY (no HTML column, no markdown) — the email
 *     template escapes it for the html part and carries it verbatim in the
 *     text part (see templates.ts:renderOrgAnnouncement).
 *   - audit_log metadata carries the subject line (short, not sensitive) but
 *     NEVER the body — mirroring notification_log's "recipient + subject only"
 *     privacy posture.
 *   - Recipients are resolved INSIDE org context — role/audience filtering
 *     can never cross an org boundary.
 *
 * TWO CALLING FORMS per command:
 *   fn(session, input)          — app code.
 *   fnWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { appUser, membership, memberMessage, org, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { isMembershipRole } from '@aeroops/core';
import type { MembershipRole } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { sendNotificationWithDb } from './send-notification.js';
import { getEmailProvider } from './email-provider.js';

// ─── Shared audience/role validation ──────────────────────────────────────────

const audienceRoleShape = {
  audience: z.enum(['all_active', 'role'], {
    message: 'audience must be "all_active" or "role"',
  }),
  role: z.string().optional(),
};

function checkAudienceRole(
  val: { audience: 'all_active' | 'role'; role?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (val.audience === 'role') {
    if (!val.role || !isMembershipRole(val.role)) {
      ctx.addIssue({
        code: 'custom',
        message: 'role is required and must be a valid membership role when audience is "role"',
        path: ['role'],
      });
    }
  } else if (val.role !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'role must not be set when audience is "all_active"',
      path: ['role'],
    });
  }
}

// ─── resolveActiveRecipientsTx — shared internal, NOT exported ────────────────

/**
 * Upper bound on recipients for a single broadcast. The fan-out is a
 * sequential best-effort loop (one sendNotification per recipient); on a
 * serverless request a blast to tens of thousands of members would exceed
 * the function timeout. Rather than SILENTLY truncate (some members would
 * miss the message with no signal), sendMemberMessage refuses above this
 * bound and asks the operator to narrow by role. Generous enough for a large
 * academy's per-role sends; a true org-wide blast to more than this is a
 * queued-delivery job (deferred forward seam).
 */
export const MAX_MEMBER_MESSAGE_RECIPIENTS = 5000;

interface RecipientRow {
  id: string;
  email: string;
}

/**
 * resolveActiveRecipientsTx — active app_user rows in this org, optionally
 * filtered to one membership.role. Runs on an ALREADY org-scoped tx (RLS is
 * the enforcement backstop — no explicit org_id predicate needed beyond
 * what the join already requires).
 */
async function resolveActiveRecipientsTx(
  tx: AnyDb,
  audience: 'all_active' | 'role',
  role: string | undefined,
): Promise<RecipientRow[]> {
  const conditions = [eq(appUser.status, 'active')];
  if (audience === 'role' && role) {
    conditions.push(eq(membership.role, role as MembershipRole));
  }

  const rows = await tx
    .select({ id: appUser.id, email: appUser.email })
    .from(appUser)
    .innerJoin(membership, eq(membership.userId, appUser.id))
    .where(and(...conditions));

  // De-dupe defensively (membership is one-row-per-user-per-org; mirrors
  // notifyMaintenanceDue's identical defensive de-dupe).
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

// ─── previewMemberMessageRecipients ────────────────────────────────────────────

const previewInputSchema = z.object(audienceRoleShape).superRefine(checkAudienceRole);

export interface PreviewMemberMessageRecipientsResult {
  recipientCount: number;
}

async function _previewMemberMessageRecipientsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<PreviewMemberMessageRecipientsResult> {
  requireCapability(session, 'org:manage_settings');

  const parsed = previewInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[notifications] invalid previewMemberMessageRecipients input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { audience, role } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const recipients = await resolveActiveRecipientsTx(tx, audience, role);
    return { recipientCount: recipients.length };
  });
}

export async function previewMemberMessageRecipients(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<PreviewMemberMessageRecipientsResult> {
  const db = await getDb();
  return _previewMemberMessageRecipientsImpl(db, session, input);
}

export async function previewMemberMessageRecipientsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<PreviewMemberMessageRecipientsResult> {
  return _previewMemberMessageRecipientsImpl(db, session, input);
}

// ─── sendMemberMessage ────────────────────────────────────────────────────────

const sendInputSchema = z
  .object({
    subject: z
      .string()
      .trim()
      .min(1, { message: 'subject is required' })
      .max(200, { message: 'subject must be 200 characters or fewer' }),
    body: z
      .string()
      .trim()
      .min(1, { message: 'body is required' })
      .max(5000, { message: 'body must be 5000 characters or fewer' }),
    ...audienceRoleShape,
  })
  .superRefine(checkAudienceRole);

export type SendMemberMessageInput = z.infer<typeof sendInputSchema>;

export interface SendMemberMessageResult {
  ok: true;
  messageId: string;
  recipientCount: number;
  sentCount: number;
  skippedCount: number;
  failedCount: number;
}

async function _sendMemberMessageImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SendMemberMessageResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'org:manage_settings');

  // 2. VALIDATE.
  const parsed = sendInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[notifications] invalid sendMemberMessage input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { subject, body, audience, role } = parsed.data;

  // 3. Resolve recipients + org name, INSERT the member_message row + audit
  //    row, all in ONE committed tx.
  const { messageId, recipients, orgName } = await withSessionOrgContextWithDb(
    db,
    session,
    async (sess, tx) => {
      const recipientRows = await resolveActiveRecipientsTx(tx, audience, role);

      // Refuse (before any row persists) rather than silently truncate a blast.
      if (recipientRows.length > MAX_MEMBER_MESSAGE_RECIPIENTS) {
        throw new ValidationError(
          `[notifications] sendMemberMessage: ${recipientRows.length} recipients exceeds the ` +
            `${MAX_MEMBER_MESSAGE_RECIPIENTS} per-message limit — narrow the audience by role.`,
        );
      }

      const orgRows = await tx.select({ name: org.name }).from(org).where(eq(org.id, sess.orgId)).limit(1);
      const orgRow = orgRows[0];
      if (!orgRow) {
        throw new Error(`[sendMemberMessage] Org row not found for orgId=${sess.orgId}`);
      }

      const inserted = await tx
        .insert(memberMessage)
        .values({
          orgId: sess.orgId,
          sentBy: sess.userId,
          subject,
          body,
          audience,
          role: audience === 'role' ? (role as string) : null,
          recipientCount: recipientRows.length,
        })
        .returning();

      const row = inserted[0];
      if (!row) throw new Error('[notifications] sendMemberMessage: member_message INSERT returned no rows');

      await tx.insert(auditLog).values({
        orgId: sess.orgId,
        actorUserId: sess.userId,
        action: 'org.announcement_sent',
        entityType: 'member_message',
        entityId: row.id,
        metadata: {
          subject,
          audience,
          role: audience === 'role' ? role : null,
          recipientCount: recipientRows.length,
        },
      });

      return { messageId: row.id, recipients: recipientRows, orgName: orgRow.name };
    },
  );

  // 4. Best-effort fan-out — AFTER the tx above has committed (mirrors
  //    notifyMaintenanceDue's calling convention). One bad recipient never
  //    aborts the rest; each sendNotificationWithDb call is independently
  //    best-effort and never throws.
  const provider = getEmailProvider();
  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const recipient of recipients) {
    const result = await sendNotificationWithDb(
      db,
      session,
      {
        toUserId: recipient.id,
        eventType: 'org.announcement',
        templateData: { subject, body, orgName },
      },
      provider,
    );
    if (result.sent) sentCount++;
    else if (result.reason === 'opted_out') skippedCount++;
    else failedCount++;
  }

  return {
    ok: true,
    messageId,
    recipientCount: recipients.length,
    sentCount,
    skippedCount,
    failedCount,
  };
}

export async function sendMemberMessage(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SendMemberMessageResult> {
  const db = await getDb();
  return _sendMemberMessageImpl(db, session, input);
}

export async function sendMemberMessageWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SendMemberMessageResult> {
  return _sendMemberMessageImpl(db, session, input);
}

// ─── listMemberMessages ────────────────────────────────────────────────────────

export interface MemberMessageView {
  id: string;
  sentBy: string;
  subject: string;
  body: string;
  audience: 'all_active' | 'role';
  role: string | null;
  recipientCount: number;
  createdAt: Date;
}

function toMemberMessageView(r: {
  id: string;
  sentBy: string;
  subject: string;
  body: string;
  audience: string;
  role: string | null;
  recipientCount: number;
  createdAt: Date;
}): MemberMessageView {
  return {
    id: r.id,
    sentBy: r.sentBy,
    subject: r.subject,
    body: r.body,
    audience: r.audience as MemberMessageView['audience'],
    role: r.role,
    recipientCount: r.recipientCount,
    createdAt: r.createdAt,
  };
}

async function _listMemberMessagesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<MemberMessageView[]> {
  requireCapability(session, 'org:manage_settings');

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const rows = await tx
      .select({
        id: memberMessage.id,
        sentBy: memberMessage.sentBy,
        subject: memberMessage.subject,
        body: memberMessage.body,
        audience: memberMessage.audience,
        role: memberMessage.role,
        recipientCount: memberMessage.recipientCount,
        createdAt: memberMessage.createdAt,
      })
      .from(memberMessage)
      .orderBy(desc(memberMessage.createdAt));

    return rows.map(toMemberMessageView);
  });
}

export async function listMemberMessages(
  session: AppSession | null | undefined,
): Promise<MemberMessageView[]> {
  const db = await getDb();
  return _listMemberMessagesImpl(db, session);
}

export async function listMemberMessagesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<MemberMessageView[]> {
  return _listMemberMessagesImpl(db, session);
}
