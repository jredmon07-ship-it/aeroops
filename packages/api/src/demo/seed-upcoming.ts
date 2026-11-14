/**
 * demo/seed-upcoming.ts — keeps the demo from looking empty past tomorrow.
 *
 * Adds two things to each demo org, both relative to "today":
 *
 *   1. A forward schedule for the coming six weeks, a repeating weekly pattern
 *      of lessons, solos and rentals, so the schedule, board and calendar views
 *      have something on every day a visitor browses to.
 *   2. A few operator announcements on the Messages page, "sent" over the last
 *      two weeks.
 *
 * A demo seeded once still ages, so the hosted demo re-seeds daily
 * (demo/scheduled-reset.ts) and both of these move forward with it.
 *
 * Reservations go through the REAL gated create path (createReservationWithDb):
 * conflict detection, booking policies and the other gates all apply. Any
 * refusal THROWS: a pattern that collides with the baseline seed must fail
 * loudly in tests, not thin out silently on the live demo.
 *
 * Announcements are inserted as member_message rows directly, with created_at
 * backdated. The real send path (sendMemberMessage) also e-mails every
 * recipient, and a daily re-seed must never mail the demo addresses. The
 * recipient count is resolved like the real path's (active users, optionally
 * one role), with explicit org predicates since the seed may run as a
 * superuser. This is the same guarded direct-insert posture as the seed's
 * member tags.
 *
 * DEMO-ONLY, like the rest of demo/.
 */
import { and, eq } from 'drizzle-orm';
import { withOrgContext, appUser, membership, memberMessage } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import type { MembershipRole } from '@aeroops/core';
import type { AppSession } from '../auth/types.js';
import { createReservationWithDb } from '../scheduling/create-reservation.js';
import { atLocal, weekdayAt } from './demo-clock.js';

/** How far ahead the forward schedule runs (days from today). */
export const UPCOMING_DAYS = 42;

/** One weekly slot in a forward-schedule pattern. */
export interface UpcomingSlot {
  /** Days of the week it repeats on (0 = Sunday … 6 = Saturday), demo wall clock. */
  weekdays: number[];
  /** Start time on the demo wall clock. */
  hour: number;
  minute?: number;
  durationMinutes: number;
  resourceIds: string[];
  /** Occurrence notes, used in rotation. */
  notes: string[];
  /** Earliest day offset this slot may use; defaults to the pattern's first day. */
  fromDay?: number;
}

/**
 * seedUpcomingReservations — book every slot occurrence from `firstDay` through
 * `lastDay` (day offsets from today) through the real gated create path.
 * Throws on the first refusal. Returns how many reservations were created.
 */
export async function seedUpcomingReservations(
  db: AnyDb,
  session: AppSession,
  slots: UpcomingSlot[],
  range: { firstDay: number; lastDay: number },
): Promise<number> {
  const used = slots.map(() => 0);
  let created = 0;
  for (let day = range.firstDay; day <= range.lastDay; day++) {
    const dow = weekdayAt(day);
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      if (day < (slot.fromDay ?? range.firstDay) || !slot.weekdays.includes(dow)) continue;
      const startAt = atLocal(day, slot.hour, slot.minute ?? 0);
      const endAt = new Date(startAt.getTime() + slot.durationMinutes * 60_000);
      const notes = slot.notes[used[i]! % slot.notes.length]!;
      used[i] = used[i]! + 1;
      const r = await createReservationWithDb(db, session, {
        startAt,
        endAt,
        resourceIds: slot.resourceIds,
        notes,
      });
      if (!r.ok) {
        throw new Error(
          `[demo] upcoming reservation "${notes}" on day +${day} was refused (${r.reason}) — ` +
            'the forward schedule collides with the baseline seed.',
        );
      }
      created++;
    }
  }
  return created;
}

/** One operator announcement for the Messages page. */
export interface DemoAnnouncement {
  /** How long ago it was sent: days before today, at this wall-clock hour. */
  daysAgo: number;
  hour: number;
  /** The sending owner/manager (app_user id). */
  sentBy: string;
  subject: string;
  /** Plain text, like the real composer. */
  body: string;
  audience: 'all_active' | 'role';
  role?: MembershipRole;
}

/** seedAnnouncements — insert the org's announcements (no e-mail fan-out; see above). */
export async function seedAnnouncements(
  db: AnyDb,
  orgId: string,
  items: DemoAnnouncement[],
): Promise<void> {
  await withOrgContext(db, orgId, async (tx) => {
    for (const m of items) {
      // Explicit org predicates: the seed runs as a superuser locally and in
      // tests, where RLS does not apply, so the org scope must not rest on it.
      const conditions = [eq(appUser.orgId, orgId), eq(appUser.status, 'active')];
      if (m.audience === 'role' && m.role) conditions.push(eq(membership.role, m.role));
      const recipients = await tx
        .select({ id: appUser.id })
        .from(appUser)
        .innerJoin(
          membership,
          and(eq(membership.userId, appUser.id), eq(membership.orgId, orgId)),
        )
        .where(and(...conditions));
      await tx.insert(memberMessage).values({
        orgId,
        sentBy: m.sentBy,
        subject: m.subject,
        body: m.body,
        audience: m.audience,
        role: m.audience === 'role' ? (m.role ?? null) : null,
        recipientCount: new Set(recipients.map((r) => r.id)).size,
        createdAt: atLocal(-m.daysAgo, m.hour),
      });
    }
  });
}
