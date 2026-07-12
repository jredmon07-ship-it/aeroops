/**
 * people/types.ts — public result/IO types for the People/Members API
 * (Slice 6.2). Framework-agnostic; no I/O.
 *
 * DESIGN POSTURE:
 *   - Operational refusals (not_found, last_owner, etc.) are RETURNED as
 *     discriminated-union values, NOT thrown. The UI renders them as messages.
 *   - Auth failures are THROWN as ForbiddenError / UnauthenticatedError.
 *   - Validation failures are THROWN as ValidationError.
 *
 * [VERIFY-6-A] (HARD COMPLIANCE LINE): member_tag.tag is a FREE-TEXT operator
 * label ONLY. The system attaches NO FAA currency, medical, flight-review,
 * Part 61/141, endorsement, or eligibility status from a tag.
 *
 * [VERIFY-6-C]: "upcomingReservations" = reservation.created_by (booking owner),
 * NOT a pilot/student flight assignment or logbook entry.
 *
 * [VERIFY-6-D]: status is a ROSTER FLAG, NOT a login gate. 'inactive' does not
 * block authentication in this slice.
 */

import type { MembershipRole } from '@aeroops/core';
import type { DispatchTicketView } from '../dispatch/types.js';

// ─── Tag color palette (migration 0041) ───────────────────────────────────────

/**
 * MEMBER_TAG_COLORS — the fixed palette KEY set a member tag may be colored
 * with. These are opaque presentation keys (NOT CSS/hex values): the web layer
 * maps a key to a literal Tailwind class, so there is no dynamic class
 * construction. Kept in lockstep with member_tag_color_check (migration 0041).
 *
 * [VERIFY-6-A]: a tag's color is a DISPLAY hint only — no regulatory or
 * eligibility meaning is attached to a tag or its color.
 */
export const MEMBER_TAG_COLORS = [
  'slate',
  'red',
  'amber',
  'green',
  'sky',
  'violet',
  'rose',
  'teal',
] as const;

/** One of the eight palette keys (see MEMBER_TAG_COLORS). */
export type MemberTagColor = (typeof MEMBER_TAG_COLORS)[number];

// ─── MemberTagView ────────────────────────────────────────────────────────────

/**
 * MemberTagView — one tag attached to a member.
 * Tags are free-text opaque operator labels only. [VERIFY-6-A]
 */
export interface MemberTagView {
  id: string;
  tag: string;
  /**
   * OPTIONAL palette-key color hint (migration 0041). null = no color (the UI
   * renders the neutral 'slate' default). A DISPLAY hint only. [VERIFY-6-A]
   */
  color: MemberTagColor | null;
  createdBy: string;
  createdAt: Date;
}

// ─── MemberTagChipView ────────────────────────────────────────────────────────

/**
 * MemberTagChipView — a lightweight tag chip (label + color) for the roster
 * list, where the full MemberTagView (id/createdBy/createdAt) is unneeded.
 */
export interface MemberTagChipView {
  tag: string;
  /** null = no color → UI renders the neutral 'slate' default. [VERIFY-6-A] */
  color: MemberTagColor | null;
}

// ─── UpcomingMemberReservationRow ─────────────────────────────────────────────

/**
 * UpcomingMemberReservationRow — one upcoming booked reservation CREATED BY
 * this member (reservation.created_by). NOT a pilot/student assignment.
 * [VERIFY-6-C]
 */
export interface UpcomingMemberReservationRow {
  id: string;
  startAt: Date;
  endAt: Date;
  seriesId: string | null;
}

// ─── MemberDetail ─────────────────────────────────────────────────────────────

/**
 * MemberDetail — full aggregated detail for a single org member.
 *
 * Returned by getMemberDetail (and post-write re-reads). All facets are
 * fetched inside a single org context (no N+1, no cross-org peek).
 *
 * [VERIFY-6-A]: tags are free-text opaque labels only.
 * [VERIFY-6-C]: upcomingReservations = created_by, not flight assignment.
 * [VERIFY-6-D]: status is a roster flag, not a login gate.
 */
export interface MemberDetail {
  userId: string;
  displayName: string;
  email: string;
  phone: string | null;
  /** ROSTER FLAG only — NOT a login gate. [VERIFY-6-D] */
  status: string;
  role: MembershipRole;
  joinedAt: Date;
  /**
   * Whether this member has login access (an auth_credential row EXISTS).
   * Existence only — the password hash is NEVER read or exposed. Drives the
   * "Roster entry — no login yet" hint ([AUTH-DECISION]); a member added via
   * addMember has no credential until a future invite/set-password slice.
   */
  hasLogin: boolean;
  /** Free-text operator labels only. [VERIFY-6-A] */
  tags: MemberTagView[];
  /**
   * Upcoming booked reservations BOOKED BY this member (created_by).
   * NOT a flight assignment or training credit. [VERIFY-6-C]
   * ≤10, ordered by start_at ASC.
   */
  upcomingReservations: UpcomingMemberReservationRow[];
  /**
   * Recent dispatch tickets where this member was the pilot.
   * ≤10, newest-first (incl. voided for audit history).
   */
  recentDispatch: DispatchTicketView[];
}

// ─── OrgMemberListRow ─────────────────────────────────────────────────────────

/**
 * OrgMemberListRow — one row in the member list (listMembers).
 * Lightweight summary: identity + role + status + tags.
 */
export interface OrgMemberListRow {
  userId: string;
  /** fullName when present, otherwise email. */
  displayName: string;
  email: string;
  role: MembershipRole;
  /** ROSTER FLAG only — NOT a login gate. [VERIFY-6-D] */
  status: string;
  phone: string | null;
  /** Free-text operator labels only. [VERIFY-6-A] */
  tags: string[];
  /**
   * Same tags as `tags`, each paired with its optional palette-key color
   * (migration 0041), for colored chips on the roster. Ordered identically to
   * `tags`. A DISPLAY hint only. [VERIFY-6-A]
   */
  tagChips: MemberTagChipView[];
  tagCount: number;
}

// ─── Keyset pagination (listMembersPage) ──────────────────────────────────────

/**
 * MemberCursor — keyset cursor for stable pagination over the member roster.
 *
 * The sort key is (sortName, id) where sortName = COALESCE(full_name, email)
 * (never null; email is NOT NULL) and id = membership.user_id (uuid PK, unique).
 * The pair is a strict total order, so keyset paging is deterministic and
 * gap-free even when full_name is null. Ascending (A→Z).
 */
export interface MemberCursor {
  /** COALESCE(full_name, email) of the last row on the prior page. */
  sortName: string;
  /** user_id (uuid) of the last row on the prior page — tie-break. */
  id: string;
}

/**
 * ListMembersPageOptions — options for the paginated member read.
 * Backward-compat note: this is a SEPARATE surface from listMembers (which
 * stays unbounded/array-returning for pickers, mobile, reporting).
 */
export interface ListMembersPageOptions {
  /** When true, include inactive members. Default: active-only. */
  includeInactive?: boolean;
  /** Rows per page; default 100, capped at 500. */
  limit?: number;
  /** Keyset cursor from a prior page's nextCursor. */
  cursor?: MemberCursor;
}

/**
 * ListMembersPage — one page of members plus an optional nextCursor.
 * nextCursor is present ONLY when a full page was returned (more may exist).
 */
export interface ListMembersPage {
  rows: OrgMemberListRow[];
  nextCursor?: MemberCursor;
}

// ─── Result unions ────────────────────────────────────────────────────────────

/** getMemberDetail result */
export type GetMemberDetailResult =
  | { ok: true; member: MemberDetail }
  | { ok: false; reason: 'not_found' };

/** updateMember result */
export type UpdateMemberResult =
  | { ok: true; member: MemberDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'last_owner' };

/** setMemberStatus result */
export type SetMemberStatusResult =
  | { ok: true; member: MemberDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'last_owner' }
  | { ok: false; reason: 'cannot_deactivate_self' };

/** addMemberTag result */
export type AddMemberTagResult =
  | { ok: true; member: MemberDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'duplicate' };

/** removeMemberTag result */
export type RemoveMemberTagResult =
  | { ok: true; member: MemberDetail }
  | { ok: false; reason: 'not_found' };

/** addMember result */
export type AddMemberResult =
  | { ok: true; member: MemberDetail }
  | { ok: false; reason: 'email_taken' };
