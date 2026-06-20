/**
 * portal/actions.ts — Server actions for the student/renter self-service portal
 * (Slice P1.2).
 *
 * Pattern mirrors reporting-actions.ts and people/actions.ts:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability inside the fn).
 *   3. Map ForbiddenError / UnauthenticatedError → { error: 'forbidden'|'unauthenticated' }.
 *   4. Serialize Dates → ISO strings at the action boundary.
 *
 * THE LOAD-BEARING REQUIREMENT — SELF-SCOPING:
 *   getMyPortalSummary takes no userId parameter. The API enforces that the
 *   subject is session.userId from the verified JWT only. This file passes the
 *   session through unchanged — there is no client-controlled userId here.
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 * RLS + session.userId self-scoping enforced inside the API functions.
 *
 * [VERIFY-T1-B]: progressRatio is content-coverage, NOT a regulatory outcome.
 * [VERIFY-6-A]: tags are free-text only — no FAA/currency/medical meaning.
 * [MONEY BOUNDARY]: No price, rate, balance, or billing data in the portal.
 */
'use server';

import { auth } from '@/auth';
import {
  getMyPortalSummary,
  ForbiddenError,
  UnauthenticatedError,
} from '@aeroops/api';
import type {
  MyPortalSummary,
  MyAccountView,
  MyReservationRow,
  MyEnrollmentRow,
} from '@aeroops/api';

// ─── Error shapes ─────────────────────────────────────────────────────────────

export type AuthErrorResult =
  | { error: 'forbidden' }
  | { error: 'unauthenticated' };

export type ServerErrorResult = { error: 'server'; message?: string };

function mapAuthError(err: unknown): AuthErrorResult | null {
  if (err instanceof ForbiddenError) return { error: 'forbidden' };
  if (err instanceof UnauthenticatedError) return { error: 'unauthenticated' };
  return null;
}

// ─── Serialized types (Dates → ISO strings) ────────────────────────────────────

/** MyAccountView with Date objects replaced by ISO strings. */
export interface SerializedMyAccountView {
  userId: string;
  displayName: string;
  email: string;
  phone: string | null;
  role: string;
  joinedAt: string; // ISO string
  tags: Array<{ id: string; tag: string }>;
}

/** MyReservationRow with Date objects replaced by ISO strings. */
export interface SerializedMyReservationRow {
  id: string;
  startAt: string; // ISO string
  endAt: string;   // ISO string
  seriesId: string | null;
  resourceIds: string[];
  role: 'booker' | 'pilot' | 'booker_and_pilot';
}

/** MyEnrollmentRow with Date objects replaced by ISO strings. */
export interface SerializedMyEnrollmentRow {
  enrollmentId: string;
  courseId: string;
  courseTitle: string;
  status: string;
  enrolledAt: string;       // ISO string
  statusChangedAt: string | null; // ISO string
  completedCount: number;
  totalLessons: number;
  progressRatio: {
    completed: number;
    total: number;
    ratio: number;
    percent: number;
  };
}

/** MyPortalSummary with all Dates serialized. */
export interface SerializedMyPortalSummary {
  account: SerializedMyAccountView;
  reservations: SerializedMyReservationRow[];
  training: SerializedMyEnrollmentRow[];
}

function serializeAccount(a: MyAccountView): SerializedMyAccountView {
  return {
    userId: a.userId,
    displayName: a.displayName,
    email: a.email,
    phone: a.phone,
    role: a.role,
    joinedAt: a.joinedAt instanceof Date ? a.joinedAt.toISOString() : String(a.joinedAt),
    tags: a.tags,
  };
}

function serializeReservation(r: MyReservationRow): SerializedMyReservationRow {
  return {
    id: r.id,
    startAt: r.startAt instanceof Date ? r.startAt.toISOString() : String(r.startAt),
    endAt: r.endAt instanceof Date ? r.endAt.toISOString() : String(r.endAt),
    seriesId: r.seriesId,
    resourceIds: r.resourceIds,
    role: r.role,
  };
}

function serializeEnrollment(e: MyEnrollmentRow): SerializedMyEnrollmentRow {
  return {
    enrollmentId: e.enrollmentId,
    courseId: e.courseId,
    courseTitle: e.courseTitle,
    status: e.status,
    enrolledAt: e.enrolledAt instanceof Date ? e.enrolledAt.toISOString() : String(e.enrolledAt),
    statusChangedAt:
      e.statusChangedAt instanceof Date
        ? e.statusChangedAt.toISOString()
        : e.statusChangedAt !== null
          ? String(e.statusChangedAt)
          : null,
    completedCount: e.completedCount,
    totalLessons: e.totalLessons,
    progressRatio: {
      completed: e.progressRatio.completed,
      total: e.progressRatio.total,
      ratio: e.progressRatio.ratio,
      percent: e.progressRatio.percent,
    },
  };
}

function serializeSummary(s: MyPortalSummary): SerializedMyPortalSummary {
  return {
    account: serializeAccount(s.account),
    reservations: s.reservations.map(serializeReservation),
    training: s.training.map(serializeEnrollment),
  };
}

// ─── getMyPortalSummaryAction ─────────────────────────────────────────────────

export type GetMyPortalSummaryActionResult =
  | { ok: true; summary: SerializedMyPortalSummary }
  | AuthErrorResult
  | ServerErrorResult;

/**
 * getMyPortalSummaryAction — server action for the portal page.
 *
 * requireCapability('portal:access') is enforced inside getMyPortalSummary().
 * The session is obtained from the signed JWT — the caller cannot supply a
 * userId, so self-scoping is guaranteed.
 */
export async function getMyPortalSummaryAction(): Promise<GetMyPortalSummaryActionResult> {
  const session = await auth();
  try {
    const summary = await getMyPortalSummary(session);
    return { ok: true, summary: serializeSummary(summary) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}
