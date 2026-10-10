/**
 * auth/mobile-session.ts — issue / refresh / revoke mobile refresh-token
 * sessions (Slice 4M-REVOKE, migration 0033, [VERIFY-4M-SEC-1] predecessor).
 *
 * THE MODEL (standard short-access + rotating-refresh):
 *   - ACCESS token: signMobileToken (mobile-token.ts) — a stateless signed
 *     JWE, unchanged shape, now SHORT-LIVED (~15 min, MOBILE_ACCESS_TOKEN_
 *     MAX_AGE_SECONDS). Read routes keep verifying it with verifyMobileToken,
 *     completely unchanged.
 *   - REFRESH token: an opaque 256-bit random string (node:crypto
 *     randomBytes → base64url), returned to the client EXACTLY ONCE. The
 *     server stores ONLY a sha256 hash of it in `mobile_session`.
 *
 * HASHING CHOICE — sha256, NOT argon2 — deliberate, see below:
 *   argon2 (packages/api/src/auth/hash.ts) is the RIGHT tool for passwords:
 *   low-entropy human-chosen secrets need a slow, salted, memory-hard
 *   function to resist offline brute force, and verification is a single
 *   known-candidate compare (no need for equality lookup across rows).
 *   A refresh token is the OPPOSITE shape: a 256-bit output of
 *   node:crypto.randomBytes — an offline brute-force/dictionary attack
 *   against that keyspace is already computationally infeasible regardless
 *   of hash speed. What we DO need is an O(1) equality lookup by hash (the
 *   `mobile_session_refresh_token_hash_unique` index) — impossible with
 *   argon2's per-call random salt (verifying would require re-hashing the
 *   candidate against every stored row). sha256 is deterministic (enables
 *   the index), fast (no artificial latency on every schedule read's silent
 *   refresh), and — given the token's own entropy already defeats brute
 *   force — loses no real security by being fast. This mirrors how GitHub-
 *   style opaque API/session tokens are stored (fast hash of a
 *   high-entropy token), a DIFFERENT and correct precedent from password
 *   storage.
 *
 * ROTATION + REUSE DETECTION (fail-closed):
 *   Every successful refresh consumes the presented refresh token and
 *   issues a NEW refresh token + a new short-lived access token — the OLD
 *   row is marked rotated_to_id = <new row id> AND revoked_at = now() in
 *   the SAME transaction as the new row's insert. A refresh token can only
 *   ever be used ONCE.
 *
 *   If a refresh token is presented whose row ALREADY has rotated_to_id set
 *   (i.e. it was already consumed once before), that is definitive evidence
 *   the token was captured and is being replayed (either a bug, or — more
 *   likely — theft of a stored/leaked refresh token) — refreshMobileSession
 *   responds by walking the rotation chain FORWARD from that row and
 *   revoking every not-yet-revoked descendant, then returns null. This logs
 *   out the ENTIRE chain, including whatever device is currently holding
 *   the newest (legitimate) token — a deliberate fail-closed/forces-re-login
 *   response to a theft signal, not a convenience-preserving one.
 *
 * ANTI-ENUMERATION: refreshMobileSession returns null (→ the route's generic
 * 401) for EVERY failure case — unknown hash, expired, plain-revoked
 * (logout), AND reuse-detected — all indistinguishable to the caller.
 *
 * ORG CONTEXT: issueMobileSession trusts claims.orgId (already resolved by
 * verifyLoginAndIssueClaims via resolveOrgBySlug — never client input).
 * refreshMobileSession/revokeMobileSession trust ONLY the orgId that
 * resolveMobileSessionByHash resolved from OUR OWN mobile_session row (a
 * sanctioned platform-admin read, see resolve-mobile-session.ts) — never
 * from caller input. Every WRITE happens inside withOrgContext using that
 * resolved orgId.
 *
 * TWO CALLING FORMS (mirrors verify-login.ts): issueMobileSession/
 * refreshMobileSession/revokeMobileSession all take `db` explicitly (the
 * mobile auth routes already hold `db` from getDb()). The `*WithDb` names
 * are aliases kept for test-import clarity, matching verifyLoginAndIssue
 * ClaimsWithDb's precedent. revokeAllMobileSessionsForUser is different: it
 * is a SESSION-gated admin/self action (mirrors revokeCalendarFeed), so it
 * follows the (session, input) + internal getDb() convention instead.
 */
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  withOrgContext,
  mobileSession,
  org,
  appUser,
  membership,
  auditLog,
} from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from './require-capability.js';
import { withSessionOrgContextWithDb } from './session.js';
import { getDb } from '../db.js';
import type { AppSession } from './types.js';
import type { MobileClaims } from './verify-login.js';
import { signMobileToken, MOBILE_ACCESS_TOKEN_MAX_AGE_SECONDS } from './mobile-token.js';
import { resolveMobileSessionByHash } from './resolve-mobile-session.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** 256 bits of entropy — the raw refresh token (node:crypto randomBytes). */
const REFRESH_TOKEN_BYTES = 32;

/** 30 days in milliseconds — the refresh token's absolute lifetime. */
const REFRESH_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Defensive cap on rotation-chain walk length — chains cannot legitimately
 * cycle (each rotated_to_id points strictly forward to a freshly-inserted
 * row), but this bounds a pathological/corrupted chain from an unbounded
 * loop. */
const MAX_CHAIN_HOPS = 1000;

// ─── Token primitives ─────────────────────────────────────────────────────────

/**
 * generateRefreshToken — a long, cryptographically-random, URL-safe opaque
 * token (32 raw bytes → 43-char base64url string, ~256 bits of entropy).
 * Mirrors calendar/internal.ts's generateFeedToken exactly. NEVER logged.
 */
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/**
 * hashRefreshToken — sha256 hex digest of a raw refresh token.
 * See the file header for why sha256 (not argon2) is the correct choice.
 */
export function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

// ─── Result shape ─────────────────────────────────────────────────────────────

export interface IssuedMobileSession {
  accessToken: string;
  /** ISO-8601 timestamp. */
  accessExpiresAt: string;
  /** The raw refresh token — returned to the client EXACTLY ONCE. */
  refreshToken: string;
  /** ISO-8601 timestamp. */
  refreshExpiresAt: string;
}

function expiryTimestamps(now: number): { accessExpiresAt: Date; refreshExpiresAt: Date } {
  return {
    accessExpiresAt: new Date(now + MOBILE_ACCESS_TOKEN_MAX_AGE_SECONDS * 1000),
    refreshExpiresAt: new Date(now + REFRESH_TOKEN_MAX_AGE_MS),
  };
}

// ─── loadMobileClaims — re-derive claims for an already-trusted (orgId, userId) ─

/**
 * loadMobileClaims — re-reads {slug, role, email} for a refresh's new access
 * token, given an orgId/userId ALREADY resolved from our own mobile_session
 * row (never client input). Runs inside the caller's withOrgContext tx.
 *
 * Defensive checks beyond the original login (an improvement over the 4M.1
 * 8h token, which could not react to either of these mid-flight):
 *   - org.status must still be 'active' (an org suspended after login can no
 *     longer mint refreshed access tokens).
 *   - a membership row must still exist (a user removed from the org after
 *     login can no longer mint refreshed access tokens).
 *
 * Returns null if the org/user/membership no longer supports a valid session
 * (fail-closed — refreshMobileSession maps this to the generic null/401).
 */
async function loadMobileClaims(
  tx: AnyDb,
  orgId: string,
  userId: string,
): Promise<MobileClaims | null> {
  const orgRows = await tx
    .select({ slug: org.slug, status: org.status })
    .from(org)
    .where(eq(org.id, orgId))
    .limit(1);
  const orgRow = orgRows[0];
  if (!orgRow || orgRow.status !== 'active') return null;

  const userRows = await tx
    .select({ email: appUser.email })
    .from(appUser)
    .where(and(eq(appUser.id, userId), eq(appUser.orgId, orgId)))
    .limit(1);
  const userRow = userRows[0];
  if (!userRow) return null;

  const memberRows = await tx
    .select({ role: membership.role })
    .from(membership)
    .where(and(eq(membership.userId, userId), eq(membership.orgId, orgId)))
    .limit(1);
  const memberRow = memberRows[0];
  if (!memberRow) return null;

  return {
    userId,
    orgId,
    slug: orgRow.slug,
    role: memberRow.role,
    email: userRow.email,
  };
}

// ─── Rotation-chain revoke (reuse detection) ──────────────────────────────────

/**
 * revokeChainFrom — walks the rotation chain starting at `startId` (a row
 * already known to be in the caller's org) and revokes every not-yet-revoked
 * row it finds by following rotated_to_id forward. Called ONLY when a reuse
 * (already-rotated) refresh token is presented — see refreshMobileSession.
 *
 * Idempotent + bounded (MAX_CHAIN_HOPS) — safe to call even if some rows in
 * the chain are already revoked (the common case: the presented row itself
 * was revoked at the moment it was rotated).
 */
interface ChainLinkRow {
  id: string;
  revokedAt: Date | null;
  rotatedToId: string | null;
}

async function fetchChainLink(tx: AnyDb, id: string, orgId: string): Promise<ChainLinkRow | undefined> {
  const rows: ChainLinkRow[] = await tx
    .select({
      id: mobileSession.id,
      revokedAt: mobileSession.revokedAt,
      rotatedToId: mobileSession.rotatedToId,
    })
    .from(mobileSession)
    .where(and(eq(mobileSession.id, id), eq(mobileSession.orgId, orgId)))
    .limit(1);
  return rows[0];
}

async function revokeChainFrom(tx: AnyDb, startId: string, orgId: string): Promise<void> {
  let currentId: string | null = startId;
  const seen = new Set<string>();
  let hops = 0;

  while (currentId && hops < MAX_CHAIN_HOPS) {
    if (seen.has(currentId)) break; // defensive cycle guard — should be unreachable.
    seen.add(currentId);
    hops++;

    const row = await fetchChainLink(tx, currentId, orgId);
    if (!row) break;

    if (!row.revokedAt) {
      await tx
        .update(mobileSession)
        .set({ revokedAt: new Date() })
        .where(eq(mobileSession.id, row.id));
    }

    currentId = row.rotatedToId;
  }
}

// ─── issueMobileSession ────────────────────────────────────────────────────────

export interface IssueMobileSessionOpts {
  /** Free-text, operator/device-supplied, OPTIONAL. Display-only. */
  deviceLabel?: string;
}

/**
 * issueMobileSession — mints a fresh access+refresh pair at LOGIN.
 *
 * claims MUST already come from verifyLoginAndIssueClaims (orgId/userId are
 * server-resolved, never client input). Inserts one mobile_session row
 * (hashed refresh token only) inside withOrgContext(claims.orgId, ...) and
 * audits 'mobile.session_issued'.
 *
 * @param db     - Drizzle client (prod or test).
 * @param claims - MobileClaims from verifyLoginAndIssueClaims.
 * @param opts   - Optional deviceLabel.
 */
export async function issueMobileSession(
  db: AnyDb,
  claims: MobileClaims,
  opts: IssueMobileSessionOpts = {},
): Promise<IssuedMobileSession> {
  const rawRefreshToken = generateRefreshToken();
  const refreshTokenHash = hashRefreshToken(rawRefreshToken);
  const accessToken = await signMobileToken(claims);
  const now = Date.now();
  const { accessExpiresAt, refreshExpiresAt } = expiryTimestamps(now);

  await withOrgContext(db, claims.orgId, async (tx) => {
    const inserted = await tx
      .insert(mobileSession)
      .values({
        orgId: claims.orgId,
        userId: claims.userId,
        refreshTokenHash,
        deviceLabel: opts.deviceLabel ?? null,
        expiresAt: refreshExpiresAt,
      })
      .returning();

    const row = inserted[0];
    if (!row) throw new Error('[auth] issueMobileSession: insert returned no row');

    await tx.insert(auditLog).values({
      orgId: claims.orgId,
      actorUserId: claims.userId,
      action: 'mobile.session_issued',
      entityType: 'mobile_session',
      entityId: row.id,
      metadata: { deviceLabel: row.deviceLabel },
    });
  });

  return {
    accessToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
    refreshToken: rawRefreshToken,
    refreshExpiresAt: refreshExpiresAt.toISOString(),
  };
}

/** Test-import alias — identical contract, mirrors verifyLoginAndIssueClaimsWithDb. */
export async function issueMobileSessionWithDb(
  db: AnyDb,
  claims: MobileClaims,
  opts: IssueMobileSessionOpts = {},
): Promise<IssuedMobileSession> {
  return issueMobileSession(db, claims, opts);
}

// ─── refreshMobileSession ───────────────────────────────────────────────────────

/**
 * refreshMobileSession — exchanges a raw refresh token for a fresh
 * access+refresh pair, ROTATING the refresh token (the presented one is
 * consumed and can never be used again).
 *
 * Returns null (→ the route's generic 401) on ANY of:
 *   - unknown hash (no such session),
 *   - reuse of an already-rotated token (theft signal — additionally revokes
 *     the entire forward chain as a side effect, fail-closed),
 *   - a plainly revoked session (logout),
 *   - an expired session.
 * All four are INDISTINGUISHABLE to the caller — anti-enumeration.
 *
 * @param db            - Drizzle client (prod or test).
 * @param rawRefreshToken - The raw refresh token from the client (never logged).
 */
export async function refreshMobileSession(
  db: AnyDb,
  rawRefreshToken: string,
): Promise<IssuedMobileSession | null> {
  const hash = hashRefreshToken(rawRefreshToken);
  const resolved = await resolveMobileSessionByHash(db, hash);
  if (!resolved) return null;

  const now = Date.now();

  // ── Reuse detection FIRST (must run even though the row is already
  //    revoked from the original rotation — revokedAt is not the signal). ──
  if (resolved.rotatedToId !== null) {
    await withOrgContext(db, resolved.orgId, async (tx) => {
      await revokeChainFrom(tx, resolved.id, resolved.orgId);
      await tx.insert(auditLog).values({
        orgId: resolved.orgId,
        actorUserId: resolved.userId,
        action: 'mobile.session_reuse_detected',
        entityType: 'mobile_session',
        entityId: resolved.id,
        metadata: {},
      });
    });
    return null;
  }

  // ── Plain revoke (logout) — fail closed. ──
  if (resolved.revokedAt !== null) return null;

  // ── Expired — fail closed. ──
  if (resolved.expiresAt.getTime() <= now) return null;

  // ── Valid — atomically CLAIM the parent, then rotate. ──
  return withOrgContext(db, resolved.orgId, async (tx) => {
    // SINGLE-USE under concurrency: the consume is a guarded conditional UPDATE
    // (rotated_to_id IS NULL AND revoked_at IS NULL). Postgres serializes the two
    // concurrent UPDATEs on the row lock, so exactly ONE refresh wins. Losing
    // (0 rows) means a concurrent refresh already rotated/revoked this token —
    // treat it as reuse and FAIL CLOSED (revoke the whole chain). Without this
    // guard, two simultaneous refreshes of one captured token both read the same
    // pre-tx snapshot and each spawn a live, independently-rotating chain that
    // reuse-detection never catches. [security: audit MEDIUM, atomic rotation]
    const claimed = await tx
      .update(mobileSession)
      .set({ revokedAt: new Date(now), lastUsedAt: new Date(now) })
      .where(
        and(
          eq(mobileSession.id, resolved.id),
          isNull(mobileSession.rotatedToId),
          isNull(mobileSession.revokedAt),
        ),
      )
      .returning({ id: mobileSession.id });

    if (claimed.length === 0) {
      // Lost the race / already consumed → indistinguishable from token reuse.
      await revokeChainFrom(tx, resolved.id, resolved.orgId);
      await tx.insert(auditLog).values({
        orgId: resolved.orgId,
        actorUserId: resolved.userId,
        action: 'mobile.session_reuse_detected',
        entityType: 'mobile_session',
        entityId: resolved.id,
        metadata: { reason: 'rotation_race' },
      });
      return null;
    }

    const claims = await loadMobileClaims(tx, resolved.orgId, resolved.userId);
    if (!claims) return null; // org suspended / user removed (parent already revoked).

    const rawNewRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = hashRefreshToken(rawNewRefreshToken);
    const accessToken = await signMobileToken(claims);
    const { accessExpiresAt, refreshExpiresAt } = expiryTimestamps(now);

    const inserted = await tx
      .insert(mobileSession)
      .values({
        orgId: resolved.orgId,
        userId: resolved.userId,
        refreshTokenHash: newRefreshTokenHash,
        expiresAt: refreshExpiresAt,
      })
      .returning();

    const newRow = inserted[0];
    if (!newRow) throw new Error('[auth] refreshMobileSession: insert returned no row');

    // Link parent → child (the parent was already revoked by the guarded claim).
    await tx
      .update(mobileSession)
      .set({ rotatedToId: newRow.id })
      .where(eq(mobileSession.id, resolved.id));

    await tx.insert(auditLog).values({
      orgId: resolved.orgId,
      actorUserId: resolved.userId,
      action: 'mobile.session_refreshed',
      entityType: 'mobile_session',
      entityId: newRow.id,
      metadata: { rotatedFrom: resolved.id },
    });

    return {
      accessToken,
      accessExpiresAt: accessExpiresAt.toISOString(),
      refreshToken: rawNewRefreshToken,
      refreshExpiresAt: refreshExpiresAt.toISOString(),
    };
  });
}

/** Test-import alias — identical contract. */
export async function refreshMobileSessionWithDb(
  db: AnyDb,
  rawRefreshToken: string,
): Promise<IssuedMobileSession | null> {
  return refreshMobileSession(db, rawRefreshToken);
}

// ─── revokeMobileSession (logout) ───────────────────────────────────────────────

/**
 * revokeMobileSession — revokes the session matching a raw refresh token
 * (LOGOUT). IDEMPOTENT: an unknown, already-revoked, or expired token is a
 * silent no-op — logout always "succeeds" from the caller's perspective (the
 * route returns 200 either way), matching revokeCalendarFeed's posture.
 *
 * @param db              - Drizzle client (prod or test).
 * @param rawRefreshToken - The raw refresh token to revoke (never logged).
 */
export async function revokeMobileSession(db: AnyDb, rawRefreshToken: string): Promise<void> {
  const hash = hashRefreshToken(rawRefreshToken);
  const resolved = await resolveMobileSessionByHash(db, hash);
  if (!resolved || resolved.revokedAt !== null) return; // unknown or already revoked — no-op.

  await withOrgContext(db, resolved.orgId, async (tx) => {
    // Optimistic guard: only revoke if STILL unrevoked (isNull, not eq —
    // `col = NULL` is never true in SQL). A concurrent revoke/rotate racing
    // in between resolve and this update just means 0 rows update — a
    // harmless no-op, not an error (logout is idempotent by design).
    const updated = await tx
      .update(mobileSession)
      .set({ revokedAt: new Date() })
      .where(and(eq(mobileSession.id, resolved.id), isNull(mobileSession.revokedAt)))
      .returning();

    if (!updated[0]) return;

    await tx.insert(auditLog).values({
      orgId: resolved.orgId,
      actorUserId: resolved.userId,
      action: 'mobile.session_revoked',
      entityType: 'mobile_session',
      entityId: resolved.id,
      metadata: { reason: 'logout' },
    });
  });
}

/** Test-import alias — identical contract. */
export async function revokeMobileSessionWithDb(db: AnyDb, rawRefreshToken: string): Promise<void> {
  return revokeMobileSession(db, rawRefreshToken);
}

// ─── revokeAllMobileSessionsForUser (self or admin) ─────────────────────────────

/**
 * revokeAllMobileSessionsForUser — revokes every NOT-yet-revoked mobile
 * session for a given user, within the caller's own org.
 *
 * SESSION-GATED (mirrors revokeCalendarFeed's shape, not the pre-auth
 * issue/refresh/revoke-by-token forms above): the caller must be
 * authenticated. Self-service (targetUserId === session.userId) needs only
 * baseline 'app:access' (every authenticated role has it — you may always
 * sign yourself out of every device). Revoking ANOTHER user's sessions
 * additionally requires 'people:manage' (owner/manager only — the same cap
 * that gates editing another member's account, Slice 6).
 *
 * org_id is ALWAYS session.orgId — a caller can never reach into another
 * org's sessions, even with people:manage (that capability is itself
 * evaluated within the caller's own org membership).
 *
 * NOT wired to any route in this slice (no UI consumes it yet) — exists as
 * a tested building block for a future "sign out other devices" surface.
 *
 * @param session      - AppSession (from NextAuth `auth()` or a mobile session).
 * @param targetUserId - The user whose sessions should be revoked.
 */
async function _revokeAllMobileSessionsForUserImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  targetUserId: string,
): Promise<{ revokedCount: number }> {
  requireCapability(session, 'app:access');
  if (session && session.userId !== targetUserId) {
    requireCapability(session, 'people:manage');
  }

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const rows = await tx
      .select({ id: mobileSession.id })
      .from(mobileSession)
      .where(
        and(
          eq(mobileSession.orgId, sess.orgId),
          eq(mobileSession.userId, targetUserId),
          // revokedAt IS NULL — only rows not yet revoked.
        ),
      );

    let revokedCount = 0;
    for (const row of rows) {
      const updated = await tx
        .update(mobileSession)
        .set({ revokedAt: new Date() })
        .where(and(eq(mobileSession.id, row.id), eq(mobileSession.orgId, sess.orgId)))
        .returning();
      if (updated[0] && updated[0].revokedAt !== null) {
        revokedCount++;
      }
    }

    if (revokedCount > 0) {
      await tx.insert(auditLog).values({
        orgId: sess.orgId,
        actorUserId: sess.userId,
        action: 'mobile.session_revoked_all',
        entityType: 'app_user',
        entityId: targetUserId,
        metadata: { revokedCount },
      });
    }

    return { revokedCount };
  });
}

export async function revokeAllMobileSessionsForUser(
  session: AppSession | null | undefined,
  targetUserId: string,
): Promise<{ revokedCount: number }> {
  const db = await getDb();
  return _revokeAllMobileSessionsForUserImpl(db, session, targetUserId);
}

export async function revokeAllMobileSessionsForUserWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  targetUserId: string,
): Promise<{ revokedCount: number }> {
  return _revokeAllMobileSessionsForUserImpl(db, session, targetUserId);
}
