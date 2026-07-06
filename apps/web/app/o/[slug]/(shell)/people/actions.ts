/**
 * people/actions.ts — Server actions for the People/Members module (Slice 6.3).
 *
 * Pattern mirrors fleet/actions.ts:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability inside the fn).
 *   3. Map ForbiddenError / UnauthenticatedError → { error: 'forbidden'|'unauthenticated' }.
 *   4. Map ValidationError (code === 'VALIDATION') → { error: 'validation', message }.
 *   5. Pass through ok:false arms as-is (operational refusals are values, not errors).
 *
 * Dates are serialized to ISO strings at the action boundary so RSC → client
 * components receive plain JSON (Dates are NOT JSON-serializable).
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 * RLS + org_id scoping are enforced inside the API functions.
 *
 * [VERIFY-6-A]: tags are free-text only — no FAA/currency/medical meaning.
 * [VERIFY-6-C]: upcomingReservations = created_by, not flight assignment.
 * [VERIFY-6-D]: status is a roster flag, NOT a login gate in this slice.
 */
'use server';

import { serializePilotLog, type SerializedPilotLog } from '@/lib/serialize-pilot-log';

import { serializeDate } from '@/lib/serialize-date';

import { auth } from '@/auth';
import {
  listMembers,
  listMembersPage,
  getMemberDetail,
  updateMember,
  setMemberStatus,
  addMemberTag,
  removeMemberTag,
  addMember,
  getPilotLog,
  exportPilotLogCsv,
  ForbiddenError,
  UnauthenticatedError,
} from '@aeroops/api';
import type {
  OrgMemberListRow,
  MemberDetail,
  MemberTagView,
  UpcomingMemberReservationRow,
  GetMemberDetailResult,
  UpdateMemberResult,
  SetMemberStatusResult,
  AddMemberTagResult,
  RemoveMemberTagResult,
  AddMemberResult,
  ListMembersOptions,
  UpdateMemberInput,
  SetMemberStatusInput,
  AddMemberTagInput,
  RemoveMemberTagInput,
  AddMemberInput,
  MemberCursor,
  PilotLog,
  PilotLogEntry,
} from '@aeroops/api';
import type { DispatchTicketView } from '@aeroops/api';

// ─── Serialized types (Dates → string) ────────────────────────────────────────

export interface SerializedMemberTagView {
  id: string;
  tag: string;
  createdBy: string;
  createdAt: string;
}

export interface SerializedUpcomingMemberReservationRow {
  id: string;
  startAt: string;
  endAt: string;
  seriesId: string | null;
}

export interface SerializedDispatchTicketView {
  id: string;
  reservationId: string;
  resourceId: string;
  pilotUserId: string;
  status: string;
  hobbsOut: number;
  tachOut: number;
  hobbsIn: number | null;
  tachIn: number | null;
  flightTimeHours: number | null;
  notes: string | null;
  openedBy: string;
  openedAt: string;
  closedBy: string | null;
  closedAt: string | null;
}

export interface SerializedMemberDetail {
  userId: string;
  displayName: string;
  email: string;
  phone: string | null;
  /** ROSTER FLAG only — NOT a login gate. [VERIFY-6-D] */
  status: string;
  role: string;
  joinedAt: string;
  /** Whether the member has login access (auth_credential EXISTS — hash never read). */
  hasLogin: boolean;
  /** Free-text operator labels only. [VERIFY-6-A] */
  tags: SerializedMemberTagView[];
  /**
   * Upcoming booked reservations BOOKED BY this member (created_by).
   * NOT a flight assignment or training credit. [VERIFY-6-C]
   */
  upcomingReservations: SerializedUpcomingMemberReservationRow[];
  /** Recent dispatch tickets where this member was the pilot. */
  recentDispatch: SerializedDispatchTicketView[];
}

// ─── Error shapes ──────────────────────────────────────────────────────────────

export type AuthErrorResult =
  | { error: 'forbidden' }
  | { error: 'unauthenticated' };

export type ValidationErrorResult = {
  error: 'validation';
  message: string;
};

export type ServerErrorResult = { error: 'server'; message?: string };

function mapAuthError(err: unknown): AuthErrorResult | null {
  if (err instanceof ForbiddenError) return { error: 'forbidden' };
  if (err instanceof UnauthenticatedError) return { error: 'unauthenticated' };
  return null;
}

function isValidationError(err: unknown): err is { message: string; code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'VALIDATION'
  );
}

// ─── Date serialization helpers ────────────────────────────────────────────────
function serializeTag(t: MemberTagView): SerializedMemberTagView {
  return {
    id: t.id,
    tag: t.tag,
    createdBy: t.createdBy,
    createdAt: serializeDate(t.createdAt) ?? '',
  };
}

function serializeReservation(
  r: UpcomingMemberReservationRow,
): SerializedUpcomingMemberReservationRow {
  return {
    id: r.id,
    startAt: serializeDate(r.startAt) ?? '',
    endAt: serializeDate(r.endAt) ?? '',
    seriesId: r.seriesId,
  };
}

function serializeDispatchTicket(t: DispatchTicketView): SerializedDispatchTicketView {
  return {
    id: t.id,
    reservationId: t.reservationId,
    resourceId: t.resourceId,
    pilotUserId: t.pilotUserId,
    status: t.status,
    hobbsOut: t.hobbsOut,
    tachOut: t.tachOut,
    hobbsIn: t.hobbsIn,
    tachIn: t.tachIn,
    flightTimeHours: t.flightTimeHours,
    notes: t.notes,
    openedBy: t.openedBy,
    openedAt: serializeDate(t.openedAt) ?? '',
    closedBy: t.closedBy,
    closedAt: serializeDate(t.closedAt),
  };
}

function serializeMemberDetail(m: MemberDetail): SerializedMemberDetail {
  return {
    userId: m.userId,
    displayName: m.displayName,
    email: m.email,
    phone: m.phone,
    status: m.status,
    role: m.role,
    joinedAt: serializeDate(m.joinedAt) ?? '',
    hasLogin: m.hasLogin,
    tags: m.tags.map(serializeTag),
    upcomingReservations: m.upcomingReservations.map(serializeReservation),
    recentDispatch: m.recentDispatch.map(serializeDispatchTicket),
  };
}

// ─── listMembersAction ─────────────────────────────────────────────────────────

export type ListMembersActionResult =
  | { ok: true; members: OrgMemberListRow[] }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function listMembersAction(
  opts?: ListMembersOptions,
): Promise<ListMembersActionResult> {
  const session = await auth();
  try {
    const members = await listMembers(session, opts);
    return { ok: true, members };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── listMembersPageAction (keyset pagination) ───────────────────────────────
// MemberCursor is JSON-safe (two strings) — no date serialization needed.

export type ListMembersPageActionResult =
  | { ok: true; members: OrgMemberListRow[]; nextCursor: MemberCursor | null }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function listMembersPageAction(input?: {
  includeInactive?: boolean;
  limit?: number;
  cursor?: MemberCursor;
}): Promise<ListMembersPageActionResult> {
  const session = await auth();
  try {
    const page = await listMembersPage(session, input ?? {});
    return { ok: true, members: page.rows, nextCursor: page.nextCursor ?? null };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── getMemberDetailAction ─────────────────────────────────────────────────────

export type GetMemberDetailActionResult =
  | { ok: true; member: SerializedMemberDetail }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getMemberDetailAction(input: {
  userId: string;
}): Promise<GetMemberDetailActionResult> {
  const session = await auth();
  try {
    const result: GetMemberDetailResult = await getMemberDetail(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, member: serializeMemberDetail(result.member) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── updateMemberAction ────────────────────────────────────────────────────────

export type UpdateMemberActionResult =
  | { ok: true; member: SerializedMemberDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'last_owner' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function updateMemberAction(
  input: UpdateMemberInput,
): Promise<UpdateMemberActionResult> {
  const session = await auth();
  try {
    const result: UpdateMemberResult = await updateMember(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, member: serializeMemberDetail(result.member) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── setMemberStatusAction ─────────────────────────────────────────────────────

export type SetMemberStatusActionResult =
  | { ok: true; member: SerializedMemberDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'last_owner' }
  | { ok: false; reason: 'cannot_deactivate_self' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function setMemberStatusAction(
  input: SetMemberStatusInput,
): Promise<SetMemberStatusActionResult> {
  const session = await auth();
  try {
    const result: SetMemberStatusResult = await setMemberStatus(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, member: serializeMemberDetail(result.member) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── addMemberTagAction ────────────────────────────────────────────────────────

export type AddMemberTagActionResult =
  | { ok: true; member: SerializedMemberDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'duplicate' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function addMemberTagAction(
  input: AddMemberTagInput,
): Promise<AddMemberTagActionResult> {
  const session = await auth();
  try {
    const result: AddMemberTagResult = await addMemberTag(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, member: serializeMemberDetail(result.member) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── removeMemberTagAction ─────────────────────────────────────────────────────

export type RemoveMemberTagActionResult =
  | { ok: true; member: SerializedMemberDetail }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function removeMemberTagAction(
  input: RemoveMemberTagInput,
): Promise<RemoveMemberTagActionResult> {
  const session = await auth();
  try {
    const result: RemoveMemberTagResult = await removeMemberTag(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, member: serializeMemberDetail(result.member) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── addMemberAction ───────────────────────────────────────────────────────────

export type AddMemberActionResult =
  | { ok: true; member: SerializedMemberDetail }
  | { ok: false; reason: 'email_taken' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function addMemberAction(
  input: AddMemberInput,
): Promise<AddMemberActionResult> {
  const session = await auth();
  try {
    const result: AddMemberResult = await addMember(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, member: serializeMemberDetail(result.member) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// Slice P2 — Pilot logbook facet (staff read, per member)
//
// COMPLIANCE HARD LINE: a CONVENIENCE VIEW of the operator's dispatch history
// for this member — NOT their official/certified §61.51 logbook of record.
// Makes NO currency/experience/§61.51/§61.57 determination.
//
// Gated on people:access (getPilotLogAction) inside the @aeroops/api command.
// A cross-org / non-member userId → { ok:false, reason:'not_found' }.
// ════════════════════════════════════════════════════════════════════════════════


export interface PilotLogDateBounds {
  from?: string;
  to?: string;
}

export type GetPilotLogActionResult =
  | { ok: true; log: SerializedPilotLog }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getPilotLogAction(
  userId: string,
  input?: PilotLogDateBounds,
): Promise<GetPilotLogActionResult> {
  const session = await auth();
  try {
    const result = await getPilotLog(session, { userId, ...input });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, log: serializePilotLog(result.log) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

export type ExportPilotLogCsvActionResult =
  | { ok: true; filename: string; csv: string }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function exportPilotLogCsvAction(
  userId: string,
  input?: PilotLogDateBounds,
): Promise<ExportPilotLogCsvActionResult> {
  const session = await auth();
  try {
    const result = await exportPilotLogCsv(session, { userId, ...input });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, filename: result.filename, csv: result.csv };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}
