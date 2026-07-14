/**
 * people/avatar.ts — member profile photos (Slice AVATARS, migration 0048).
 *
 * An optional small profile photo per account (Flight Circle parity), stored
 * INLINE as a size-capped data-URI on app_user.avatar_data — no object-storage
 * dependency. The client downscales to ≤256px before upload; the zod schema
 * here is the server gate and the migration-0048 CHECK is the DB backstop.
 *
 * FUNCTIONS:
 *   getMyAvatar        — app:access → the caller's own avatar (or null).
 *   getMemberAvatars   — people:access → bounded batch read for lists (≤200).
 *   setMyAvatar        — app:access → set/clear the caller's OWN photo.
 *   updateMemberAvatar — people:manage → set/clear ANY org member's photo
 *                        (front-desk uploads for members without logins).
 *
 * GRACEFUL ABSENCE: migration 0048 is STAGED, NOT APPLIED to prod. Until a
 * human applies it the avatar_data column does not exist — reads return
 * available:false with null avatars (the UI shows initials only) and writes
 * return { ok:false, reason:'not_available' }.
 *
 * GUARANTEES:
 *   - requireCapability FIRST on every function.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop —
 *     an avatar is exactly as tenant-scoped as the app_user row it sits on).
 *   - STORED, NEVER INTERPRETED (document-storage posture): the image is
 *     displayed back to the same org only; the data-URI allowlist
 *     (png/jpeg/webp) means the column can never smuggle another content type.
 *   - Writes are audited ('people.avatar_changed'); the audit row records WHO
 *     changed WHOSE avatar, never the image bytes.
 *   - NO money, NO FAA/regulatory meaning.
 *
 * TWO CALLING FORMS per function: fn(session, input) / fnWithDb(db, ...).
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { extractRows } from '../db-rows.js';

// ─── Constants + validation ───────────────────────────────────────────────────

/** Matches migration 0048's CHECK: capped data-URI, image types only. */
export const AVATAR_MAX_CHARS = 160_000;

const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

const avatarDataUrlSchema = z
  .string()
  .max(AVATAR_MAX_CHARS, { message: `avatar must be at most ${AVATAR_MAX_CHARS} characters` })
  .regex(AVATAR_DATA_URL_RE, { message: 'avatar must be a base64 data URI of type png, jpeg, or webp' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const setMyAvatarInputSchema = z.object({
  /** null clears the photo (back to initials). */
  avatarDataUrl: avatarDataUrlSchema.nullable(),
});

const updateMemberAvatarInputSchema = z.object({
  memberUserId: z.string().regex(UUID_RE, { message: 'memberUserId must be a UUID' }),
  avatarDataUrl: avatarDataUrlSchema.nullable(),
});

const getMemberAvatarsInputSchema = z.object({
  userIds: z.array(z.string().regex(UUID_RE)).max(200),
});

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemberAvatarView {
  userId: string;
  avatarDataUrl: string | null;
}

export type GetMyAvatarResult = { avatarDataUrl: string | null; available: boolean };

export type GetMemberAvatarsResult = { avatars: MemberAvatarView[]; available: boolean };

export type SetAvatarResult =
  | { ok: true }
  | { ok: false; reason: 'not_available' }
  | { ok: false; reason: 'member_not_found' };

// ─── Internal helpers (column probe + guarded projections) ────────────────────

/** True iff migration 0048's app_user.avatar_data column exists (catalog-only). */
export async function appUserHasAvatarColumn(tx: AnyDb): Promise<boolean> {
  const rows = extractRows<{ present: number }>(
    await tx.execute(sql`
      SELECT 1 AS present
      FROM information_schema.columns
      WHERE table_name = 'app_user'
        AND column_name = 'avatar_data'
      LIMIT 1
    `),
  );
  return rows.length > 0;
}

async function writeAvatarTx(
  tx: AnyDb,
  orgId: string,
  actorUserId: string,
  targetUserId: string,
  avatarDataUrl: string | null,
): Promise<'ok' | 'member_not_found'> {
  // Guarded raw UPDATE — the column is deliberately absent from the Drizzle
  // schema so no unguarded select/update can hit a DB without 0048.
  const updated = extractRows<{ id: string }>(
    await tx.execute(sql`
      UPDATE "app_user"
      SET "avatar_data" = ${avatarDataUrl}, "updated_at" = NOW()
      WHERE "id" = ${targetUserId}::uuid AND "org_id" = ${orgId}::uuid
      RETURNING "id"
    `),
  );
  if (!updated[0]) return 'member_not_found';

  await tx.insert(auditLog).values({
    orgId,
    actorUserId,
    action: 'people.avatar_changed',
    entityType: 'app_user',
    entityId: targetUserId,
    // NEVER the image bytes — only whether one is now set.
    metadata: { hasAvatar: avatarDataUrl !== null, self: actorUserId === targetUserId },
  });
  return 'ok';
}

// ─── getMyAvatar ──────────────────────────────────────────────────────────────

async function _getMyAvatarImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<GetMyAvatarResult> {
  requireCapability(session, 'app:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    if (!(await appUserHasAvatarColumn(tx))) {
      return { avatarDataUrl: null, available: false };
    }
    const rows = extractRows<{ avatar_data: string | null }>(
      await tx.execute(sql`
        SELECT "avatar_data" FROM "app_user"
        WHERE "id" = ${sess.userId}::uuid AND "org_id" = ${sess.orgId}::uuid
        LIMIT 1
      `),
    );
    return { avatarDataUrl: rows[0]?.avatar_data ?? null, available: true };
  });
}

export async function getMyAvatar(session: AppSession | null | undefined): Promise<GetMyAvatarResult> {
  const db = await getDb();
  return _getMyAvatarImpl(db, session);
}

export async function getMyAvatarWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<GetMyAvatarResult> {
  return _getMyAvatarImpl(db, session);
}

// ─── getMemberAvatars ─────────────────────────────────────────────────────────

async function _getMemberAvatarsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GetMemberAvatarsResult> {
  requireCapability(session, 'people:access');

  const parsed = getMemberAvatarsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[people] invalid getMemberAvatars input: ${first?.message ?? 'unknown'}`);
  }
  const { userIds } = parsed.data;
  if (userIds.length === 0) return { avatars: [], available: true };

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    if (!(await appUserHasAvatarColumn(tx))) {
      return { avatars: userIds.map((userId) => ({ userId, avatarDataUrl: null })), available: false };
    }
    // House ANY(ARRAY[...]) idiom (auto-schedule-internal.ts) — each id is its
    // own bound param, never string-concatenated.
    const idList = sql.join(userIds.map((id) => sql`${id}::uuid`), sql`, `);
    const rows = extractRows<{ id: string; avatar_data: string | null }>(
      await tx.execute(sql`
        SELECT "id", "avatar_data" FROM "app_user"
        WHERE "org_id" = ${sess.orgId}::uuid
          AND "id" = ANY(ARRAY[${idList}])
      `),
    );
    const byId = new Map(rows.map((r) => [r.id, r.avatar_data ?? null]));
    return {
      avatars: userIds.map((userId) => ({ userId, avatarDataUrl: byId.get(userId) ?? null })),
      available: true,
    };
  });
}

export async function getMemberAvatars(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetMemberAvatarsResult> {
  const db = await getDb();
  return _getMemberAvatarsImpl(db, session, input);
}

export async function getMemberAvatarsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetMemberAvatarsResult> {
  return _getMemberAvatarsImpl(db, session, input);
}

// ─── setMyAvatar ──────────────────────────────────────────────────────────────

async function _setMyAvatarImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetAvatarResult> {
  requireCapability(session, 'app:access');

  const parsed = setMyAvatarInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[people] invalid setMyAvatar input: ${first?.message ?? 'unknown'}`);
  }

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    if (!(await appUserHasAvatarColumn(tx))) {
      return { ok: false, reason: 'not_available' } as const;
    }
    const r = await writeAvatarTx(tx, sess.orgId, sess.userId, sess.userId, parsed.data.avatarDataUrl);
    if (r === 'member_not_found') return { ok: false, reason: 'member_not_found' } as const;
    return { ok: true } as const;
  });
}

export async function setMyAvatar(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SetAvatarResult> {
  const db = await getDb();
  return _setMyAvatarImpl(db, session, input);
}

export async function setMyAvatarWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SetAvatarResult> {
  return _setMyAvatarImpl(db, session, input);
}

// ─── updateMemberAvatar ───────────────────────────────────────────────────────

async function _updateMemberAvatarImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetAvatarResult> {
  requireCapability(session, 'people:manage');

  const parsed = updateMemberAvatarInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[people] invalid updateMemberAvatar input: ${first?.message ?? 'unknown'}`);
  }
  const { memberUserId, avatarDataUrl } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    if (!(await appUserHasAvatarColumn(tx))) {
      return { ok: false, reason: 'not_available' } as const;
    }
    const r = await writeAvatarTx(tx, sess.orgId, sess.userId, memberUserId, avatarDataUrl);
    if (r === 'member_not_found') return { ok: false, reason: 'member_not_found' } as const;
    return { ok: true } as const;
  });
}

export async function updateMemberAvatar(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SetAvatarResult> {
  const db = await getDb();
  return _updateMemberAvatarImpl(db, session, input);
}

export async function updateMemberAvatarWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SetAvatarResult> {
  return _updateMemberAvatarImpl(db, session, input);
}
