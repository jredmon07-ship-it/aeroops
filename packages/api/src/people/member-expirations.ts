/**
 * people/member-expirations.ts — operator-entered member expiration reminders
 * (Slice FC-P2 / Confirm-Dispatch parity, migration 0039 — STAGED, human-gated,
 * NOT applied).
 *
 * Flight Circle's "Confirm Dispatch" modal shows pilot medical / document
 * expirations at check-out. AeroOps parity = FREE-TEXT reminder dates the
 * operator attaches to a member (e.g. 'Medical', 'Flight review', 'Rental
 * agreement'), surfaced WARN-ONLY on the member detail page and in the
 * check-out dialog's pre-flight checklist. Expirations NEVER block dispatch —
 * the FROZEN openDispatch gate (grounded → ineligible → balance) is untouched
 * by this slice.
 *
 * COMPLIANCE (HARD LINE) [VERIFY-FC-P2-A]: Operator-entered reminder dates.
 * Not a medical/currency/legal determination — verifying actual validity
 * remains the operator's and pilot's responsibility. The 'expired' /
 * 'due_soon' / 'ok' status is PURE DATE ARITHMETIC on an operator-entered
 * reminder date, computed for display only.
 *
 * DATE HANDLING: expires_on is a plain calendar date handled END TO END as a
 * 'YYYY-MM-DD' string (drizzle date mode:'string') — NO timezone math on
 * dates, no Date-object round-trips that could drift a day across zones.
 * 'YYYY-MM-DD' strings compare correctly with plain lexicographic <.
 *
 * COMMANDS (people:manage — owner/manager only; each writes ONE audit row):
 *   addMemberExpiration        — INSERT; audit 'people.expiration_added'.
 *   deactivateMemberExpiration — active=false soft-deactivate (idempotent:
 *     already-inactive → alreadyInactive:true, NO audit row — mirrors
 *     deactivateMaintenanceItem); audit 'people.expiration_deactivated'.
 *
 * READS (people:access — owner/manager/dispatcher/cfi; zero writes):
 *   listMemberExpirations   — one member's expirations (active-only by
 *     default), expires_on ASC, each with a computed display status.
 *   listExpiringSoonForOrg  — org-wide expired + expiring-within-daysAhead
 *     (default 30) active items, joined with the member's display name.
 *
 * GUARANTEES (all four):
 *   - authz FIRST: requireCapability before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - memberUserId must be a member of this org (membership check) —
 *     cross-org ids → member_not_found / not_found, never data.
 *   - Zod-validated input; malformed → ValidationError (thrown).
 *
 * TWO CALLING FORMS per function:
 *   fn(session, input)           — app code.
 *   fnWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { eq, and, asc, lte } from 'drizzle-orm';
import { membership, appUser, memberExpiration, auditLog } from '@aeroops/db';
import type { AnyDb, MemberExpirationSelect } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Date-only helpers (pure — 'YYYY-MM-DD' strings, NO timezone math) ────────

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when s is a real calendar date in 'YYYY-MM-DD' form (rejects
 * 2026-02-30 etc.). Uses UTC components only — no local-timezone influence.
 */
export function isValidDateOnly(s: string): boolean {
  if (!DATE_ONLY_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

/** Add days to a 'YYYY-MM-DD' string, returning 'YYYY-MM-DD' (pure UTC math). */
export function addDaysDateOnly(s: string, days: number): string {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Today's date as 'YYYY-MM-DD' in UTC (the server's stable reference date). */
export function todayDateOnlyUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Days ahead a not-yet-expired reminder is flagged 'due_soon' for display. */
export const EXPIRATION_DUE_SOON_DAYS = 30;

export type MemberExpirationStatus = 'expired' | 'due_soon' | 'ok';

/**
 * classifyExpiration — pure display-status arithmetic. [VERIFY-FC-P2-A]:
 * NOT a validity determination; a reminder-date comparison only.
 * 'YYYY-MM-DD' strings compare correctly lexicographically.
 */
export function classifyExpiration(
  expiresOn: string,
  today: string,
  dueSoonDays: number = EXPIRATION_DUE_SOON_DAYS,
): MemberExpirationStatus {
  if (expiresOn < today) return 'expired';
  if (expiresOn <= addDaysDateOnly(today, dueSoonDays)) return 'due_soon';
  return 'ok';
}

// ─── Views ────────────────────────────────────────────────────────────────────

/**
 * MemberExpirationView — one member_expiration row as seen by API callers.
 * expiresOn is a 'YYYY-MM-DD' string; status is display arithmetic vs the
 * read's reference date. [VERIFY-FC-P2-A]
 */
export interface MemberExpirationView {
  id: string;
  memberUserId: string;
  /** FREE-TEXT operator label (e.g. 'Medical'). No regulatory meaning. */
  label: string;
  /** Calendar date 'YYYY-MM-DD' — no time/timezone component. */
  expiresOn: string;
  note: string | null;
  active: boolean;
  /** Display arithmetic ONLY — NOT a validity determination. [VERIFY-FC-P2-A] */
  status: MemberExpirationStatus;
  createdBy: string;
  createdAt: Date;
}

/** MemberExpirationOrgRow — org-wide row with the member's display name. */
export interface MemberExpirationOrgRow extends MemberExpirationView {
  memberDisplayName: string;
}

function toView(row: MemberExpirationSelect, today: string): MemberExpirationView {
  return {
    id: row.id,
    memberUserId: row.memberUserId,
    label: row.label,
    expiresOn: row.expiresOn,
    note: row.note,
    active: row.active,
    status: classifyExpiration(row.expiresOn, today),
    createdBy: row.createdBy,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as unknown as string),
  };
}

// ─── Input schemas ────────────────────────────────────────────────────────────

const dateOnlySchema = z
  .string()
  .regex(DATE_ONLY_RE, { message: "date must be 'YYYY-MM-DD'" })
  .refine(isValidDateOnly, { message: 'date must be a valid calendar date' });

const addMemberExpirationInputSchema = z.object({
  memberUserId: z.string().regex(UUID_RE, { message: 'memberUserId must be a UUID' }),
  label: z
    .string()
    .trim()
    .min(1, { message: 'label must not be empty' })
    .max(100, { message: 'label must be at most 100 characters' }),
  expiresOn: dateOnlySchema,
  note: z.string().trim().max(1000).optional(),
});

export type AddMemberExpirationInput = z.infer<typeof addMemberExpirationInputSchema>;

const deactivateMemberExpirationInputSchema = z.object({
  expirationId: z.string().regex(UUID_RE, { message: 'expirationId must be a UUID' }),
});

export type DeactivateMemberExpirationInput = z.infer<
  typeof deactivateMemberExpirationInputSchema
>;

const listMemberExpirationsInputSchema = z.object({
  memberUserId: z.string().regex(UUID_RE, { message: 'memberUserId must be a UUID' }),
  includeInactive: z.boolean().optional(),
  // Reference date for status arithmetic — a determinism/test seam; defaults
  // to the server's UTC date. Never persisted.
  today: dateOnlySchema.optional(),
});

export type ListMemberExpirationsInput = z.infer<typeof listMemberExpirationsInputSchema>;

const listExpiringSoonInputSchema = z.object({
  daysAhead: z
    .number()
    .int({ message: 'daysAhead must be an integer' })
    .min(1, { message: 'daysAhead must be at least 1' })
    .max(365, { message: 'daysAhead must be at most 365' })
    .optional(),
  // Reference date — determinism/test seam; defaults to the server's UTC date.
  today: dateOnlySchema.optional(),
});

export type ListExpiringSoonForOrgInput = z.infer<typeof listExpiringSoonInputSchema>;

// ─── Result unions ────────────────────────────────────────────────────────────

export type AddMemberExpirationResult =
  | { ok: true; expiration: MemberExpirationView }
  | { ok: false; reason: 'member_not_found' };

export type DeactivateMemberExpirationResult =
  | { ok: true; expiration: MemberExpirationView; alreadyInactive: boolean }
  | { ok: false; reason: 'not_found' };

export type ListMemberExpirationsResult =
  | { ok: true; expirations: MemberExpirationView[] }
  | { ok: false; reason: 'member_not_found' };

export type ListExpiringSoonForOrgResult = {
  ok: true;
  /** Active items with expires_on strictly before the reference date. */
  expired: MemberExpirationOrgRow[];
  /** Active items with reference date <= expires_on <= reference + daysAhead. */
  expiring: MemberExpirationOrgRow[];
};

// ─── addMemberExpiration ──────────────────────────────────────────────────────

async function _addMemberExpirationImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<AddMemberExpirationResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'people:manage');

  // 2. VALIDATE.
  const parsed = addMemberExpirationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[people] invalid addMemberExpiration input: ${first?.message ?? 'unknown'}`,
    );
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. memberUserId must be a member of this org (RLS also backstops).
    const memberRows = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(and(eq(membership.userId, input.memberUserId), eq(membership.orgId, sess.orgId)))
      .limit(1);
    if (!memberRows[0]) {
      return { ok: false, reason: 'member_not_found' } as const;
    }

    // 4. INSERT.
    const inserted = await tx
      .insert(memberExpiration)
      .values({
        orgId: sess.orgId,
        memberUserId: input.memberUserId,
        label: input.label,
        expiresOn: input.expiresOn,
        note: input.note && input.note.length > 0 ? input.note : null,
        createdBy: sess.userId,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error('[people] addMemberExpiration: INSERT returned no rows');
    }

    // 5. ONE audit row.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'people.expiration_added',
      entityType: 'member_expiration',
      entityId: row.id,
      metadata: {
        memberUserId: input.memberUserId,
        label: input.label,
        expiresOn: input.expiresOn,
      },
    });

    return { ok: true, expiration: toView(row, todayDateOnlyUTC()) } as const;
  });
}

export async function addMemberExpiration(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<AddMemberExpirationResult> {
  const db = await getDb();
  return _addMemberExpirationImpl(db, session, input);
}

export async function addMemberExpirationWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<AddMemberExpirationResult> {
  return _addMemberExpirationImpl(db, session, input);
}

// ─── deactivateMemberExpiration ───────────────────────────────────────────────

async function _deactivateMemberExpirationImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<DeactivateMemberExpirationResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'people:manage');

  // 2. VALIDATE.
  const parsed = deactivateMemberExpirationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[people] invalid deactivateMemberExpiration input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { expirationId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load — cross-org id is invisible under RLS → not_found.
    const currentRows = await tx
      .select()
      .from(memberExpiration)
      .where(eq(memberExpiration.id, expirationId))
      .limit(1);
    const current = currentRows[0];
    if (!current) {
      return { ok: false, reason: 'not_found' } as const;
    }

    const today = todayDateOnlyUTC();

    if (!current.active) {
      // Idempotent no-op — NO audit row (mirrors deactivateMaintenanceItem).
      return { ok: true, expiration: toView(current, today), alreadyInactive: true } as const;
    }

    // 4. Soft-deactivate (the only sanctioned post-INSERT mutation).
    const updatedRows = await tx
      .update(memberExpiration)
      .set({ active: false })
      .where(eq(memberExpiration.id, expirationId))
      .returning();
    const updated = updatedRows[0];
    if (!updated) {
      throw new Error('[people] deactivateMemberExpiration: UPDATE returned no rows');
    }

    // 5. ONE audit row (only on the true→false transition).
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'people.expiration_deactivated',
      entityType: 'member_expiration',
      entityId: expirationId,
      metadata: {
        memberUserId: current.memberUserId,
        label: current.label,
        expiresOn: current.expiresOn,
      },
    });

    return { ok: true, expiration: toView(updated, today), alreadyInactive: false } as const;
  });
}

export async function deactivateMemberExpiration(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<DeactivateMemberExpirationResult> {
  const db = await getDb();
  return _deactivateMemberExpirationImpl(db, session, input);
}

export async function deactivateMemberExpirationWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<DeactivateMemberExpirationResult> {
  return _deactivateMemberExpirationImpl(db, session, input);
}

// ─── listMemberExpirations ────────────────────────────────────────────────────

async function _listMemberExpirationsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<ListMemberExpirationsResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'people:access');

  // 2. VALIDATE.
  const parsed = listMemberExpirationsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[people] invalid listMemberExpirations input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { memberUserId, includeInactive, today: todayOverride } = parsed.data;
  const today = todayOverride ?? todayDateOnlyUTC();

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. memberUserId must be a member of THIS org — clean member_not_found
    //    instead of a silently-empty cross-org result (RLS also backstops).
    const memberRows = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(and(eq(membership.userId, memberUserId), eq(membership.orgId, sess.orgId)))
      .limit(1);
    if (!memberRows[0]) {
      return { ok: false, reason: 'member_not_found' } as const;
    }

    // 4. Read — soonest expiry first.
    const conditions = [
      eq(memberExpiration.orgId, sess.orgId),
      eq(memberExpiration.memberUserId, memberUserId),
    ];
    if (!includeInactive) conditions.push(eq(memberExpiration.active, true));

    const rows = await tx
      .select()
      .from(memberExpiration)
      .where(and(...conditions))
      .orderBy(asc(memberExpiration.expiresOn), asc(memberExpiration.createdAt));

    return { ok: true, expirations: rows.map((r) => toView(r, today)) } as const;
  });
}

export async function listMemberExpirations(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<ListMemberExpirationsResult> {
  const db = await getDb();
  return _listMemberExpirationsImpl(db, session, input);
}

export async function listMemberExpirationsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<ListMemberExpirationsResult> {
  return _listMemberExpirationsImpl(db, session, input);
}

// ─── listExpiringSoonForOrg ───────────────────────────────────────────────────

async function _listExpiringSoonForOrgImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<ListExpiringSoonForOrgResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'people:access');

  // 2. VALIDATE.
  const parsed = listExpiringSoonInputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[people] invalid listExpiringSoonForOrg input: ${first?.message ?? 'unknown'}`,
    );
  }
  const daysAhead = parsed.data.daysAhead ?? EXPIRATION_DUE_SOON_DAYS;
  const today = parsed.data.today ?? todayDateOnlyUTC();
  const horizon = addDaysDateOnly(today, daysAhead);

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. ONE query: active items at-or-before the horizon, with the member's
    //    display name. Classification into expired vs expiring is pure
    //    string comparison in JS ('YYYY-MM-DD' orders lexicographically).
    const rows = await tx
      .select({
        expiration: memberExpiration,
        fullName: appUser.fullName,
        email: appUser.email,
      })
      .from(memberExpiration)
      .innerJoin(appUser, eq(appUser.id, memberExpiration.memberUserId))
      .where(
        and(
          eq(memberExpiration.orgId, sess.orgId),
          eq(memberExpiration.active, true),
          lte(memberExpiration.expiresOn, horizon),
        ),
      )
      .orderBy(asc(memberExpiration.expiresOn), asc(memberExpiration.createdAt));

    const expired: MemberExpirationOrgRow[] = [];
    const expiring: MemberExpirationOrgRow[] = [];
    for (const r of rows) {
      const view = toView(r.expiration, today);
      const orgRow: MemberExpirationOrgRow = {
        ...view,
        memberDisplayName: r.fullName ?? r.email,
      };
      if (r.expiration.expiresOn < today) expired.push(orgRow);
      else expiring.push(orgRow);
    }

    return { ok: true, expired, expiring } as const;
  });
}

export async function listExpiringSoonForOrg(
  session: AppSession | null | undefined,
  input?: unknown,
): Promise<ListExpiringSoonForOrgResult> {
  const db = await getDb();
  return _listExpiringSoonForOrgImpl(db, session, input);
}

export async function listExpiringSoonForOrgWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input?: unknown,
): Promise<ListExpiringSoonForOrgResult> {
  return _listExpiringSoonForOrgImpl(db, session, input);
}
