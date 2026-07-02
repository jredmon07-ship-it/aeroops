/**
 * billing/get-member-billing-profile.ts — getMemberBillingProfile
 * (Slice P0-REV, C7).
 *
 * Staff READ-ONLY (billing:access): surfaces a member's auto-pay status +
 * saved-payment-method presence (DISPLAY only — never a PAN) + active dues
 * schedules, for the staff billing/accounts UI. No writes, no audit row
 * (reading is not itself a money-relevant mutation, same posture as
 * getMemberBalance/listLedgerEntries).
 *
 * GUARANTEES:
 *   - authz FIRST: billing:access before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - memberUserId must be a member of this org (membership check).
 *   - NO PAN/CVV/account-number anywhere in the returned shape.
 *
 * TWO CALLING FORMS:
 *   getMemberBillingProfile(session, input)          — app code.
 *   getMemberBillingProfileWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { membership, autopaySetting, stripePaymentMethod, duesSchedule } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toDuesScheduleView } from './dues-schedule-commands.js';
import type { DuesScheduleView } from './dues-schedule-commands.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const getMemberBillingProfileInputSchema = z.object({
  memberUserId: z.string().regex(UUID_RE, { message: 'memberUserId must be a UUID' }),
});

export type GetMemberBillingProfileInput = z.infer<typeof getMemberBillingProfileInputSchema>;

export interface MemberBillingProfileDefaultPaymentMethod {
  type: 'card' | 'us_bank_account';
  last4: string | null;
  brand: string | null;
}

export interface MemberBillingProfile {
  autopayEnabled: boolean;
  defaultPaymentMethod: MemberBillingProfileDefaultPaymentMethod | null;
  savedPaymentMethodCount: number;
  activeDuesSchedules: DuesScheduleView[];
}

export type GetMemberBillingProfileResult =
  | { ok: true; profile: MemberBillingProfile }
  | { ok: false; reason: 'not_found' };

async function _getMemberBillingProfileImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GetMemberBillingProfileResult> {
  requireCapability(session, 'billing:access');

  const parsed = getMemberBillingProfileInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[billing] invalid getMemberBillingProfile input: ${first?.message ?? 'unknown'}`);
  }
  const { memberUserId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const memberRows = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(and(eq(membership.userId, memberUserId), eq(membership.orgId, sess.orgId)))
      .limit(1);
    if (!memberRows[0]) {
      return { ok: false, reason: 'not_found' } as const;
    }

    const autopayRows = await tx
      .select()
      .from(autopaySetting)
      .where(eq(autopaySetting.userId, memberUserId))
      .limit(1);
    const autopayRow = autopayRows[0];

    const pmRows = await tx
      .select()
      .from(stripePaymentMethod)
      .where(eq(stripePaymentMethod.userId, memberUserId))
      .orderBy(desc(stripePaymentMethod.createdAt));

    let defaultPaymentMethod: MemberBillingProfileDefaultPaymentMethod | null = null;
    if (autopayRow?.defaultPaymentMethodId) {
      const defaultPm = pmRows.find((p) => p.id === autopayRow.defaultPaymentMethodId);
      if (defaultPm) {
        defaultPaymentMethod = { type: defaultPm.type as 'card' | 'us_bank_account', last4: defaultPm.last4, brand: defaultPm.brand };
      }
    }

    const scheduleRows = await tx
      .select()
      .from(duesSchedule)
      .where(and(eq(duesSchedule.userId, memberUserId), eq(duesSchedule.active, true)))
      .orderBy(desc(duesSchedule.createdAt));

    return {
      ok: true,
      profile: {
        autopayEnabled: autopayRow?.enabled ?? false,
        defaultPaymentMethod,
        savedPaymentMethodCount: pmRows.length,
        activeDuesSchedules: scheduleRows.map(toDuesScheduleView),
      },
    } as const;
  });
}

export async function getMemberBillingProfile(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetMemberBillingProfileResult> {
  const db = await getDb();
  return _getMemberBillingProfileImpl(db, session, input);
}

export async function getMemberBillingProfileWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetMemberBillingProfileResult> {
  return _getMemberBillingProfileImpl(db, session, input);
}
