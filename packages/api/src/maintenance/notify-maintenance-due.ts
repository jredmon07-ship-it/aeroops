/**
 * notify-maintenance-due.ts — notifyMaintenanceDue command (Slice P1.5).
 *
 * A manual, staff-triggered "notify" action (NO cron — scheduling is
 * maintainer infra, per docs/specs/slice-p1-maintenance-due.md deferred list):
 * given the CURRENT overdue/due_soon maintenance items, sends ONE best-effort
 * heads-up email per active owner/manager member via the existing
 * sendNotification dispatcher (send-notification.ts) — never throws, never
 * blocks the caller, records its own notification_log row per recipient.
 *
 * Short-circuits with zero sends when nothing is due — this is a heads-up,
 * not a digest of everything.
 *
 * GUARANTEES:
 *   - authz first: requireCapability('maintenance:work_order') (the existing
 *     operator maintenance-write cap — owner/manager/dispatcher/mechanic;
 *     matches who else can act on maintenance data).
 *   - org_id from session only.
 *   - Reuses loadMaintenanceDueViews (list-maintenance-due.ts) — the exact
 *     same load+evaluate logic as the read surface; no duplicated query.
 *   - Recipients: active app_user rows with membership.role IN ('owner',
 *     'manager') in the session's org (RLS-scoped).
 *   - Each send is independently best-effort (sendNotificationWithDb never
 *     throws) — one recipient's failure never blocks another's send.
 *
 * TWO CALLING FORMS:
 *   notifyMaintenanceDue(session, input)        — app code.
 *   notifyMaintenanceDueWithDb(db, session, in) — tests.
 */
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { appUser, membership } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { loadMaintenanceDueViews } from './list-maintenance-due.js';
import { sendNotificationWithDb } from '../notifications/send-notification.js';
import { getEmailProvider } from '../notifications/email-provider.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notifyMaintenanceDueInputSchema = z.object({
  resourceId: z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }).optional(),
});

export type NotifyMaintenanceDueInput = z.infer<typeof notifyMaintenanceDueInputSchema>;

export interface NotifyMaintenanceDueResult {
  overdueCount: number;
  dueSoonCount: number;
  recipientCount: number;
  sentCount: number;
  skippedCount: number;
  failedCount: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _notifyMaintenanceDueImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<NotifyMaintenanceDueResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'maintenance:work_order');

  // 2. VALIDATE.
  const parsed = notifyMaintenanceDueInputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid notifyMaintenanceDue input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceId } = parsed.data;

  // 3. Load due items + recipient ids inside ONE org context.
  const { dueItems, recipients } = await withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const views = await loadMaintenanceDueViews(tx, resourceId);
    const due = views.filter((v) => v.status === 'overdue' || v.status === 'due_soon');

    if (due.length === 0) {
      return { dueItems: due, recipients: [] as { id: string }[] };
    }

    const recipientRows = await tx
      .select({ id: appUser.id })
      .from(appUser)
      .innerJoin(membership, eq(membership.userId, appUser.id))
      .where(
        and(
          inArray(membership.role, ['owner', 'manager']),
          eq(appUser.status, 'active'),
        ),
      );

    // De-dupe (a user could theoretically appear once per membership row;
    // membership is one-row-per-user-per-org so this is defensive only).
    const seen = new Set<string>();
    const uniqueRecipients = recipientRows.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });

    return { dueItems: due, recipients: uniqueRecipients };
  });

  const overdueCount = dueItems.filter((v) => v.status === 'overdue').length;
  const dueSoonCount = dueItems.filter((v) => v.status === 'due_soon').length;

  if (dueItems.length === 0) {
    return {
      overdueCount: 0,
      dueSoonCount: 0,
      recipientCount: 0,
      sentCount: 0,
      skippedCount: 0,
      failedCount: 0,
    };
  }

  // 4. Best-effort send, one per recipient. Bounded item list in the template
  // (≤10) — this is a heads-up, not an exhaustive report.
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
        eventType: 'maintenance.due',
        templateData: {
          overdueCount,
          dueSoonCount,
          items: dueItems.slice(0, 10).map((v) => ({ title: v.title, status: v.status })),
        },
      },
      provider,
    );
    if (result.sent) sentCount++;
    else if (result.reason === 'opted_out') skippedCount++;
    else failedCount++;
  }

  return {
    overdueCount,
    dueSoonCount,
    recipientCount: recipients.length,
    sentCount,
    skippedCount,
    failedCount,
  };
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function notifyMaintenanceDue(
  session: AppSession | null | undefined,
  input: unknown = {},
): Promise<NotifyMaintenanceDueResult> {
  const db = await getDb();
  return _notifyMaintenanceDueImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function notifyMaintenanceDueWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown = {},
): Promise<NotifyMaintenanceDueResult> {
  return _notifyMaintenanceDueImpl(db, session, input);
}
