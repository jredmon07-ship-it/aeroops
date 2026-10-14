/**
 * people/login-link.ts — login links: how a member gets (or resets) a login.
 *
 * Owners/managers create a link on a member's detail page and send it to the
 * member themselves (AeroOps sends no email). The member opens it, chooses a
 * password, and can then sign in normally at /o/<slug>/login.
 *
 * THREE FUNCTIONS:
 *   createLoginLink(session, { userId })   — people:manage; audited
 *                                            'member.login_link_created'.
 *   checkLoginLink({ slug, token })        — UNAUTHENTICATED read used by the
 *                                            link page to render the form (or
 *                                            the "no longer valid" state).
 *   acceptLoginLink({ slug, token, password }) — UNAUTHENTICATED write: sets or
 *                                            replaces the auth_credential in one
 *                                            transaction; audited
 *                                            'member.login_link_accepted'.
 *
 * THE TOKEN is stateless (login-link-token.ts — no table, no migration):
 * signed with AUTH_SECRET under its own salt + purpose, 7-day expiry, and a
 * fingerprint of the member's current credential so it is SINGLE-USE (setting
 * a password changes the fingerprint and kills every earlier link).
 *
 * PRIVILEGE RULE (loginLinkPermission, pure):
 *   - An OWNER may create a link for any member of their org, themselves
 *     included. There is no change-password screen yet, so a self-link is how
 *     an owner changes their own password.
 *   - Anyone else with people:manage (today: manager) may NOT create a link
 *     for a member who also holds people:manage (owner or manager) — and so
 *     not for themselves either. Otherwise a manager could reset an owner's
 *     (or a peer's) password and take over that account.
 *   - Deactivated members (app_user.status = 'inactive') cannot get links.
 *   - The rule is checked AGAIN when the link is used (check + accept): the
 *     token carries its creator (`by`) and the target's role at mint time
 *     (`role`). If the target's role has changed since, or the creator is no
 *     longer an active member, or the rule now refuses (creator demoted,
 *     target promoted), the link is dead. A manager can't hold a link for a
 *     dispatcher and use it after that dispatcher is promoted.
 *   - Role edits follow the same rank rule (update-member.ts
 *     roleChangePermission), so a manager can't demote an owner, make a link,
 *     then restore the role.
 *   - The public demo orgs (alpha/bravo) refuse in production, or whenever the
 *     demo reset is on: their credentials are published and shared by every
 *     visitor, so one visitor's reset link would lock everyone else out. Keyed
 *     on NODE_ENV too because the hosted demo does not set the reset flag.
 *
 * EMAIL CASE: sign-in lowercases the typed email and matches it exactly, so a
 * member stored with a mixed-case email could set a password and still never
 * sign in. addMember now lowercases at the boundary; for rows stored before
 * that, createLoginLink lowercases the stored email (audited in the
 * link-created row) or refuses 'email_conflict' when another member already
 * holds the lowercase address.
 *
 * ACCEPT — fail-closed, ONE generic answer: unknown/tampered/expired/used
 * token, URL slug that is not the token's org, suspended org, member removed
 * or deactivated, fingerprint mismatch, target role changed, creator gone or
 * no longer allowed → { ok:false, reason:'invalid_link' }.
 * The token already names the member, so nothing beyond it is revealed. The
 * new password goes through the SAME newPasswordSchema + hashPassword (argon2id)
 * as signup. org_id comes ONLY from the signed token, cross-checked against
 * resolveOrgBySlug(slug); every tenant read/write runs inside withOrgContext.
 *
 * SESSIONS: accepting a link revokes the member's MOBILE refresh sessions
 * (mobile_session, same tx) so a reset signs other phones out. Web sessions
 * are stateless 8h JWTs and CANNOT be revoked — a browser already signed in
 * stays signed in until its token expires. Known limitation; see
 * docs/specs/login-links.md.
 *
 * NO email sending, NO money, NO migration.
 *
 * TWO CALLING FORMS (codebase convention): fn(...) for app code (getDb()),
 * fnWithDb(db, ...) for tests.
 */
import { z } from 'zod';
import { and, eq, isNull, ne } from 'drizzle-orm';
import {
  withOrgContext,
  appUser,
  membership,
  authCredential,
  mobileSession,
  org,
  auditLog,
} from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { can, isMembershipRole } from '@aeroops/core';
import type { MembershipRole } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { resolveOrgBySlug } from '../auth/resolve-org.js';
import { hashPassword } from '../auth/hash.js';
import { newPasswordSchema } from '../auth/password-policy.js';
import {
  signLoginLinkToken,
  verifyLoginLinkToken,
  credentialFingerprint,
  fingerprintsMatch,
  LOGIN_LINK_MAX_AGE_SECONDS,
} from '../auth/login-link-token.js';
import type { LoginLinkClaims } from '../auth/login-link-token.js';
import { DEMO_RESET_ALLOWLIST, isDemoResetCandidate } from '../demo/reset.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Types ────────────────────────────────────────────────────────────────────

/** 'invite' = the member has no login yet; 'reset' = replaces their password. */
export type LoginLinkMode = 'invite' | 'reset';

export type LoginLinkRefusal = 'self_not_allowed' | 'target_outranks';

export type CreateLoginLinkResult =
  | {
      ok: true;
      /** Path only (`/o/<slug>/login-link/<token>`) — the web layer adds the origin. */
      path: string;
      /** ISO-8601. */
      expiresAt: string;
      mode: LoginLinkMode;
    }
  | { ok: false; reason: 'not_found' | 'inactive' | 'demo_org' | 'email_conflict' | LoginLinkRefusal };

/** Demo orgs whose published, shared credentials must never be reset by a visitor. */
export function isSharedDemoOrg(slug: string): boolean {
  if (isDemoResetCandidate(slug)) return true;
  return (
    process.env['NODE_ENV'] === 'production' &&
    (DEMO_RESET_ALLOWLIST as readonly string[]).includes(slug)
  );
}

export type CheckLoginLinkResult =
  | { ok: true; email: string; displayName: string; orgName: string; mode: LoginLinkMode }
  | { ok: false; reason: 'invalid_link' };

export type AcceptLoginLinkResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'invalid_link' };

export interface CreateLoginLinkInput {
  userId: string;
}

export interface LoginLinkRef {
  slug: string;
  token: string;
}

export interface AcceptLoginLinkInput extends LoginLinkRef {
  password: string;
}

// ─── Privilege rule (pure) ────────────────────────────────────────────────────

/**
 * loginLinkPermission — may `actor` create a login link for `target`?
 * Pure; both are members of the same org (the caller guarantees that).
 * See the file header for the rule and why.
 */
export function loginLinkPermission(
  actor: { userId: string; role: MembershipRole },
  target: { userId: string; role: MembershipRole },
): { ok: true } | { ok: false; reason: LoginLinkRefusal } {
  if (actor.role === 'owner') return { ok: true };
  if (actor.userId === target.userId) return { ok: false, reason: 'self_not_allowed' };
  if (can(target.role, 'people:manage')) return { ok: false, reason: 'target_outranks' };
  return { ok: true };
}

// ─── Shared target read ───────────────────────────────────────────────────────

interface LinkTarget {
  userId: string;
  email: string;
  displayName: string;
  status: string;
  role: MembershipRole;
  /** The stored argon2 hash — used ONLY to compute the fingerprint, never returned. */
  passwordHash: string | null;
}

/**
 * loadTarget — the member + role + current credential hash, inside the
 * caller's withOrgContext tx (RLS-scoped: a user of another org is invisible).
 * forUpdate locks the app_user row so two concurrent accepts of one link
 * serialize — the second sees the new fingerprint and is refused.
 */
async function loadTarget(
  tx: AnyDb,
  orgId: string,
  userId: string,
  forUpdate = false,
): Promise<LinkTarget | null> {
  const userQuery = tx
    .select({
      id: appUser.id,
      email: appUser.email,
      fullName: appUser.fullName,
      status: appUser.status,
    })
    .from(appUser)
    .where(and(eq(appUser.id, userId), eq(appUser.orgId, orgId)))
    .limit(1);
  const userRows: Array<{ id: string; email: string; fullName: string | null; status: string }> =
    forUpdate ? await userQuery.for('update') : await userQuery;
  const user = userRows[0];
  if (!user) return null;

  const memberRows = await tx
    .select({ role: membership.role })
    .from(membership)
    .where(and(eq(membership.userId, userId), eq(membership.orgId, orgId)))
    .limit(1);
  const role = memberRows[0]?.role;
  if (!role || !isMembershipRole(role)) return null;

  const credRows = await tx
    .select({ passwordHash: authCredential.passwordHash })
    .from(authCredential)
    .where(and(eq(authCredential.userId, userId), eq(authCredential.orgId, orgId)))
    .limit(1);

  return {
    userId: user.id,
    email: user.email,
    displayName: user.fullName?.trim() || user.email,
    status: user.status,
    role,
    passwordHash: credRows[0]?.passwordHash ?? null,
  };
}

/**
 * loadActiveRole — the role of an ACTIVE member of this org, or null (removed,
 * deactivated, unknown role). Used to re-check a link's creator at use time.
 */
async function loadActiveRole(tx: AnyDb, orgId: string, userId: string): Promise<MembershipRole | null> {
  const rows: Array<{ role: string; status: string }> = await tx
    .select({ role: membership.role, status: appUser.status })
    .from(membership)
    .innerJoin(appUser, eq(membership.userId, appUser.id))
    .where(and(eq(membership.userId, userId), eq(membership.orgId, orgId), eq(appUser.orgId, orgId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.status !== 'active' || !isMembershipRole(row.role)) return null;
  return row.role;
}

// ─── createLoginLink ──────────────────────────────────────────────────────────

const createInputSchema = z.object({
  userId: z.string().regex(UUID_RE, { message: 'userId must be a UUID' }),
});

async function _createLoginLinkImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CreateLoginLinkResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'people:manage');

  // 2. VALIDATE input.
  const parsed = createInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[people] invalid createLoginLink input: ${first?.message ?? 'unknown'}`);
  }
  const { userId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Org slug from OUR org row (the link's URL), not from the caller.
    const orgRows = await tx
      .select({ slug: org.slug })
      .from(org)
      .where(eq(org.id, sess.orgId))
      .limit(1);
    const slug = orgRows[0]?.slug;
    if (!slug) return { ok: false, reason: 'not_found' } as const;
    if (isSharedDemoOrg(slug)) return { ok: false, reason: 'demo_org' } as const;

    // 4. Target must be a member of THIS org (RLS + explicit org_id).
    const target = await loadTarget(tx, sess.orgId, userId);
    if (!target) return { ok: false, reason: 'not_found' } as const;
    if (target.status !== 'active') return { ok: false, reason: 'inactive' } as const;

    // 5. Privilege rule — no manager → owner/manager takeover.
    const allowed = loginLinkPermission(
      { userId: sess.userId, role: sess.role },
      { userId: target.userId, role: target.role },
    );
    if (!allowed.ok) return { ok: false, reason: allowed.reason } as const;

    // 5b. Email case — sign-in matches the LOWERCASED email exactly, so a
    //     mixed-case row could never sign in. Lowercase it now (audited below),
    //     unless another member already holds the lowercase address.
    let emailNormalized: { from: string; to: string } | null = null;
    const lowerEmail = target.email.toLowerCase();
    if (target.email !== lowerEmail) {
      const clash = await tx
        .select({ id: appUser.id })
        .from(appUser)
        .where(and(eq(appUser.orgId, sess.orgId), eq(appUser.email, lowerEmail), ne(appUser.id, target.userId)))
        .limit(1);
      if (clash.length > 0) return { ok: false, reason: 'email_conflict' } as const;
      await tx
        .update(appUser)
        .set({ email: lowerEmail, updatedAt: new Date() })
        .where(and(eq(appUser.id, target.userId), eq(appUser.orgId, sess.orgId)));
      emailNormalized = { from: target.email, to: lowerEmail };
    }

    // 6. Mint. The fingerprint binds the link to the CURRENT credential.
    const mode: LoginLinkMode = target.passwordHash ? 'reset' : 'invite';
    const expiresAt = new Date(Date.now() + LOGIN_LINK_MAX_AGE_SECONDS * 1000);
    const token = await signLoginLinkToken({
      userId: target.userId,
      orgId: sess.orgId,
      fp: credentialFingerprint(target.passwordHash),
      by: sess.userId,
      role: target.role,
    });

    // 7. ONE audit row. The token itself is NEVER logged.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'member.login_link_created',
      entityType: 'app_user',
      entityId: target.userId,
      metadata: {
        mode,
        expiresAt: expiresAt.toISOString(),
        ...(emailNormalized ? { emailNormalized } : {}),
      },
    });

    return {
      ok: true,
      path: `/o/${slug}/login-link/${token}`,
      expiresAt: expiresAt.toISOString(),
      mode,
    } as const;
  });
}

export async function createLoginLink(
  session: AppSession | null | undefined,
  input: CreateLoginLinkInput,
): Promise<CreateLoginLinkResult> {
  const db = await getDb();
  return _createLoginLinkImpl(db, session, input);
}

export async function createLoginLinkWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CreateLoginLinkInput,
): Promise<CreateLoginLinkResult> {
  return _createLoginLinkImpl(db, session, input);
}

// ─── Link resolution (shared by check + accept) ───────────────────────────────

const INVALID = { ok: false, reason: 'invalid_link' } as const;

const refSchema = z.object({
  slug: z.string().min(1).max(200),
  token: z.string().min(1).max(4096),
});

/**
 * resolveLinkOrg — verifies the token and that the URL slug names the SAME,
 * active org. Returns null on any mismatch (→ the generic invalid_link).
 */
async function resolveLinkOrg(
  db: AnyDb,
  rawRef: unknown,
): Promise<{ claims: LoginLinkClaims; orgId: string; orgName: string } | null> {
  const parsed = refSchema.safeParse(rawRef);
  if (!parsed.success) return null;
  const { slug, token } = parsed.data;

  const claims = await verifyLoginLinkToken(token);
  if (!claims) return null;

  const resolved = await resolveOrgBySlug(db, slug);
  if (!resolved || resolved.status !== 'active' || resolved.id !== claims.orgId) return null;

  return { claims, orgId: resolved.id, orgName: resolved.name };
}

/**
 * linkStillValid — true iff the link can still be used: the target is an
 * active member with the same credential AND the same role as at mint time,
 * and the creator is still an active member whom loginLinkPermission allows
 * to make this link today. Runs inside the caller's withOrgContext tx.
 */
async function linkStillValid(
  tx: AnyDb,
  orgId: string,
  target: LinkTarget | null,
  claims: LoginLinkClaims,
): Promise<boolean> {
  if (target === null || target.status !== 'active') return false;
  if (!fingerprintsMatch(credentialFingerprint(target.passwordHash), claims.fp)) return false;
  if (target.role !== claims.role) return false;

  const creatorRole = await loadActiveRole(tx, orgId, claims.by);
  if (!creatorRole || !can(creatorRole, 'people:manage')) return false;
  return loginLinkPermission(
    { userId: claims.by, role: creatorRole },
    { userId: target.userId, role: target.role },
  ).ok;
}

// ─── checkLoginLink ───────────────────────────────────────────────────────────

async function _checkLoginLinkImpl(db: AnyDb, rawRef: unknown): Promise<CheckLoginLinkResult> {
  const link = await resolveLinkOrg(db, rawRef);
  if (!link) return INVALID;

  return withOrgContext(db, link.orgId, async (tx) => {
    const target = await loadTarget(tx, link.orgId, link.claims.userId);
    if (!target || !(await linkStillValid(tx, link.orgId, target, link.claims))) return INVALID;
    return {
      ok: true,
      email: target.email,
      displayName: target.displayName,
      orgName: link.orgName,
      mode: target.passwordHash ? 'reset' : 'invite',
    } as const;
  });
}

export async function checkLoginLink(ref: LoginLinkRef): Promise<CheckLoginLinkResult> {
  const db = await getDb();
  return _checkLoginLinkImpl(db, ref);
}

export async function checkLoginLinkWithDb(db: AnyDb, ref: LoginLinkRef): Promise<CheckLoginLinkResult> {
  return _checkLoginLinkImpl(db, ref);
}

// ─── acceptLoginLink ──────────────────────────────────────────────────────────

async function _acceptLoginLinkImpl(db: AnyDb, rawInput: unknown): Promise<AcceptLoginLinkResult> {
  const link = await resolveLinkOrg(db, rawInput);
  if (!link) return INVALID;

  // SAME password policy as signup. A weak password is the one error that is
  // specific — it reveals nothing about the account.
  const rawPassword = (rawInput as { password?: unknown } | null)?.password;
  const pw = newPasswordSchema.safeParse(rawPassword);
  if (!pw.success) {
    throw new ValidationError(`[login-link] ${pw.error.issues[0]?.message ?? 'invalid password'}`);
  }

  // Hash before the tx (argon2 is deliberately slow; keep the row lock short).
  const passwordHash = await hashPassword(pw.data);

  return withOrgContext(db, link.orgId, async (tx) => {
    const target = await loadTarget(tx, link.orgId, link.claims.userId, true);
    if (!target || !(await linkStillValid(tx, link.orgId, target, link.claims))) return INVALID;

    const mode: LoginLinkMode = target.passwordHash ? 'reset' : 'invite';
    const now = new Date();

    // Create or replace the ONE credential row (UNIQUE user_id).
    if (target.passwordHash) {
      await tx
        .update(authCredential)
        .set({ passwordHash, updatedAt: now })
        .where(and(eq(authCredential.userId, target.userId), eq(authCredential.orgId, link.orgId)));
    } else {
      await tx.insert(authCredential).values({
        orgId: link.orgId,
        userId: target.userId,
        passwordHash,
      });
    }

    // Sign other phones out (web JWTs can't be revoked — see header).
    const revoked = await tx
      .update(mobileSession)
      .set({ revokedAt: now })
      .where(
        and(
          eq(mobileSession.orgId, link.orgId),
          eq(mobileSession.userId, target.userId),
          isNull(mobileSession.revokedAt),
        ),
      )
      .returning({ id: mobileSession.id });

    await tx.insert(auditLog).values({
      orgId: link.orgId,
      actorUserId: target.userId,
      action: 'member.login_link_accepted',
      entityType: 'app_user',
      entityId: target.userId,
      metadata: { mode, mobileSessionsRevoked: revoked.length },
    });

    return { ok: true, email: target.email } as const;
  });
}

export async function acceptLoginLink(input: AcceptLoginLinkInput): Promise<AcceptLoginLinkResult> {
  const db = await getDb();
  return _acceptLoginLinkImpl(db, input);
}

export async function acceptLoginLinkWithDb(
  db: AnyDb,
  input: AcceptLoginLinkInput,
): Promise<AcceptLoginLinkResult> {
  return _acceptLoginLinkImpl(db, input);
}
