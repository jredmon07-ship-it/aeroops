/**
 * portal/types.ts — public result/IO types for the student/renter self-service
 * portal (Slice P1.1). Framework-agnostic; no I/O.
 *
 * THE LOAD-BEARING REQUIREMENT — SELF-SCOPING:
 *   Every portal read is implicitly "me": it filters to session.userId (the
 *   caller's OWN rows) IN ADDITION to org RLS. A student/renter NEVER sees
 *   another member's data, even within the same org. The reads take NO
 *   row-identifying input — there is no userId/enrollmentId param; the subject
 *   is always session.userId from the verified JWT (zero IDOR).
 *
 * COMPLIANCE POSTURE (carried over from the slices these reads surface):
 *
 *   [VERIFY-T1-H] (RESOLVED in P1.1): a member seeing their OWN training
 *   progress = operator content already recorded about them. It is NOT a new
 *   computed Part-61/141 determination, graduation, or regulatory certificate.
 *   Broad training:access is deliberately NOT granted to student/renter.
 *
 *   [VERIFY-T1-B]: progressRatio / status='completed' are content-coverage
 *   indicators ONLY (completed lessons / total lessons). NOT a Part-141
 *   completion rate or graduation determination.
 *
 *   [VERIFY-6-A]: member tags are FREE-TEXT opaque operator labels ONLY. The
 *   system attaches NO FAA currency, medical, flight-review, Part 61/141,
 *   endorsement, or eligibility status from a tag.
 *
 * NO MONEY: the portal carries no price, rate, balance, or billing data.
 *   [MONEY BOUNDARY held — zero dollars.]
 */

import type { MembershipRole } from '@aeroops/core';
import type { MemberEnrollmentRow } from '../training/types.js';

// ─── MyEnrollmentRow ──────────────────────────────────────────────────────────

/**
 * MyEnrollmentRow — one of the caller's OWN enrollments for the portal
 * "My training" card. Structurally identical to MemberEnrollmentRow (the
 * People-detail Training facet); aliased so the portal surface owns its own
 * public type name and can diverge later without a breaking re-export.
 *
 * [VERIFY-T1-B]: progressRatio is content coverage, NOT a regulatory outcome.
 */
export type MyEnrollmentRow = MemberEnrollmentRow;

// ─── MyReservationRow ─────────────────────────────────────────────────────────

/**
 * MyReservationRow — one upcoming booked reservation the caller is involved in,
 * either as the booker (reservation.created_by = me) or as the dispatched pilot
 * (a non-voided dispatch_ticket.pilot_user_id = me), or both.
 *
 * `role` is derived from which condition(s) matched:
 *   'booker'            — created_by = me, no matching non-voided dispatch.
 *   'pilot'             — dispatched pilot = me, but created_by ≠ me.
 *   'booker_and_pilot'  — both.
 *
 * resourceIds carries the aircraft tail numbers (display value) when present,
 * falling back to the resource id for non-aircraft / untailed resources.
 */
export interface MyReservationRow {
  id: string;
  startAt: Date;
  endAt: Date;
  seriesId: string | null;
  /** Tail numbers (preferred) or resource ids, for display. */
  resourceIds: string[];
  role: 'booker' | 'pilot' | 'booker_and_pilot';
}

// ─── MyAccountView ────────────────────────────────────────────────────────────

/**
 * MyAccountView — the caller's OWN identity + own free-text tags.
 *
 * Deliberately a STRICT SUBSET of MemberDetail: it does NOT expose status,
 * hasLogin, createdBy, recent dispatch, or any other member's data. The portal
 * member sees only what is theirs.
 *
 * [VERIFY-6-A]: tags are free-text opaque labels only.
 */
export interface MyAccountView {
  userId: string;
  /** fullName when present, otherwise email. */
  displayName: string;
  email: string;
  phone: string | null;
  role: MembershipRole;
  joinedAt: Date;
  /** Free-text operator labels only. [VERIFY-6-A] */
  tags: Array<{ id: string; tag: string }>;
}

// ─── MyPortalSummary ──────────────────────────────────────────────────────────

/**
 * MyPortalSummary — the portal page's single fetch. Bundles the three facets
 * fetched inside ONE org context (no N+1, no cross-org peek, all self-scoped).
 */
export interface MyPortalSummary {
  account: MyAccountView;
  reservations: MyReservationRow[];
  training: MyEnrollmentRow[];
}
