/**
 * billing/list-org-dues-schedules.ts — listOrgDuesSchedules (org-level recurring
 * billing hub read).
 *
 * Every ACTIVE dues/tuition schedule across the org, with the member's display
 * name, for the Recurring billing page. Read-only. billing:access.
 *
 * Graceful absence (migration 0050): reads cadence + anchor_month when present;
 * a pre-0050 DB reads every schedule as monthly (anchorMonth null).
 *
 * TWO CALLING FORMS:
 *   listOrgDuesSchedules(session)          — app code.
 *   listOrgDuesSchedulesWithDb(db, session) — tests.
 */

import { inArray } from 'drizzle-orm';
import { appUser } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import type { DuesCadence } from '@aeroops/core';
import { DUES_CADENCES } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { loadActiveDuesSchedules } from './dues-internal.js';

export interface OrgDuesScheduleRow {
  id: string;
  userId: string;
  memberName: string;
  amountCents: number;
  cadence: DuesCadence;
  anchorMonth: number | null;
  dayOfMonth: number;
  memo: string | null;
}

export interface ListOrgDuesSchedulesResult {
  schedules: OrgDuesScheduleRow[];
}

async function _impl(db: AnyDb, session: AppSession | null | undefined): Promise<ListOrgDuesSchedulesResult> {
  requireCapability(session, 'billing:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const rows = await loadActiveDuesSchedules(tx, sess.orgId);
    if (rows.length === 0) return { schedules: [] };

    // Name lookup (RLS-scoped) for the payer of each schedule.
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const nameRows = await tx
      .select({ id: appUser.id, fullName: appUser.fullName, email: appUser.email })
      .from(appUser)
      .where(inArray(appUser.id, userIds));
    const nameById = new Map(nameRows.map((n) => [n.id, n.fullName?.trim() || n.email]));

    const schedules: OrgDuesScheduleRow[] = rows
      .map((r) => ({
        id: r.id,
        userId: r.userId,
        memberName: nameById.get(r.userId) ?? 'Member',
        amountCents: r.amountCents,
        cadence: (DUES_CADENCES as readonly string[]).includes(r.cadence) ? (r.cadence as DuesCadence) : 'monthly',
        anchorMonth: r.anchorMonth,
        dayOfMonth: r.dayOfMonth,
        memo: r.memo,
      }))
      .sort((a, b) => a.memberName.localeCompare(b.memberName));

    return { schedules };
  });
}

export async function listOrgDuesSchedules(
  session: AppSession | null | undefined,
): Promise<ListOrgDuesSchedulesResult> {
  const db = await getDb();
  return _impl(db, session);
}

export async function listOrgDuesSchedulesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<ListOrgDuesSchedulesResult> {
  return _impl(db, session);
}
