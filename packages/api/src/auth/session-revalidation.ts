/**
 * auth/session-revalidation.ts — password resets and role changes reach web
 * sessions that are already signed in. No migration, no session table.
 *
 * WHY: web sessions are Auth.js JWTs (strategy 'jwt', 8h maxAge, re-issued by
 * the middleware on every request). Until this, nothing in a session was
 * checked against the database after sign-in: a browser signed in before a
 * login-link password reset stayed signed in, and a demoted manager kept the
 * old role claim, until the token lapsed.
 *
 * HOW:
 *   - SIGN-IN: verifyCredential computes `cfp` = sessionCredentialFingerprint(
 *     password_hash) in the SAME transaction that verified the password, and
 *     jwtCallback copies it into the token. The token is an encrypted JWE and
 *     holds only this digest, never the hash. `cfp` is never projected onto
 *     the session object (sessionCallback copies named fields only), never put
 *     in the mobile token, and never returned by a route.
 *   - EVERY server-side auth(): the Node config's jwt callback (built by
 *     createSessionJwtCallback) reads the member's role, org status and
 *     credential for (token.userId, token.orgId) under
 *     withOrgContext(token.orgId), the same RLS-scoped read the login uses:
 *       no cfp on the token (issued before this shipped) → signed out
 *       no membership in token.orgId (removed, cross-org) → signed out
 *       org not active (suspended — login refuses it too) → signed out
 *       no credential, or its fingerprint ≠ token.cfp    → signed out
 *       role differs                                     → token with the DB role
 *     "Signed out" = the callback returns null. In the installed Auth.js
 *     (@auth/core 0.41.2 lib/actions/session.js) a null token leaves the
 *     session body null and clears the session cookie, and next-auth
 *     5.0.0-beta.31 (lib/index.js) has RSC/server-action auth() return that
 *     body — so auth() returns null. (A thrown error lands in the same branch
 *     but is logged with its full message, so this module never throws.)
 *     RSC and server-action auth() cannot write cookies, so there the stale
 *     cookie stays put and is refused on every read.
 *   - EDGE: the middleware keeps the pure jwtCallback (edge-callbacks.ts). It
 *     only checks the signature + slug, so a revoked cookie still gets past it
 *     to the page or server action, whose auth() returns null: pages redirect
 *     to /o/<slug>/login, and so do server actions (apps/web/lib/action-auth.ts).
 *     The middleware treats /login as public and the login page never
 *     redirects, so a revoked session lands there once — no loop.
 *   - OTHER CREDENTIALS are checked elsewhere: a mobile access token lives 15
 *     minutes and is re-minted only through a refresh checked against the
 *     database (mobile-session.ts) — and the session cookie never verifies as
 *     one (mobile-token.ts has its own salt). A calendar feed URL is re-checked
 *     against its owner's membership, org status and role on every fetch
 *     (calendar/resolve-feed.ts); a password reset does not revoke it.
 *
 * CACHE: in-process, keyed by (orgId, userId, cfp), holding the verdict (ok +
 * role), never the hash. One page render calls auth() many times; within the
 * TTL they share one query, and concurrent calls share the in-flight one.
 * TTL = AEROOPS_SESSION_REVALIDATE_TTL_MS (default 15 s, 0 = no cache, capped
 * at 5 min), so a reset or role change applies within the TTL on an instance
 * that already checked that session. Only a GOOD verdict outlives its query:
 * a signed-out one is dropped once it settles (concurrent calls still share
 * it). The key can't tell a fresh sign-in from the session it replaces when
 * the password is unchanged — an org reactivated or a membership restored
 * signs back in with the same cfp — so a cached refusal would bounce that
 * sign-in until the TTL ran out. A refused cookie costs one query per
 * request instead, and its page redirects to the login page on the first.
 * Bounded at SESSION_REVALIDATE_CACHE_MAX_ENTRIES (oldest dropped).
 *
 * DATABASE ERRORS: fail closed. The request is treated as signed out (null),
 * the failure is logged with the error class and driver code only (a query
 * error's message carries the SQL parameters — user and org ids), and the
 * failure is not cached. No loop: the page sends the visitor to the login
 * page, which never redirects. The cookie survives (see above), so the next
 * page load after the database recovers works without signing in again.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { withOrgContext, authCredential, membership, org } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { isMembershipRole } from '@aeroops/core';
import type { MembershipRole } from '@aeroops/core';
import { jwtCallback } from './edge-callbacks.js';
import { fingerprintsMatch } from './login-link-token.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Env var: how long a session check is cached, in ms. 0 disables the cache. */
export const SESSION_REVALIDATE_TTL_ENV = 'AEROOPS_SESSION_REVALIDATE_TTL_MS';

/** 15 s — the default staleness bound for a reset or role change. */
export const DEFAULT_SESSION_REVALIDATE_TTL_MS = 15_000;

/** 5 min — a larger configured value is capped here. */
export const MAX_SESSION_REVALIDATE_TTL_MS = 5 * 60_000;

/** Most cached verdicts held per process; the oldest go first. */
export const SESSION_REVALIDATE_CACHE_MAX_ENTRIES = 1_000;

/** Domain prefix: a session cfp can never equal a login-link `fp` of the same hash. */
const SESSION_CFP_DOMAIN = 'aeroops.session-cfp:';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Fingerprint ──────────────────────────────────────────────────────────────

/**
 * sessionCredentialFingerprint — base64url sha256 of a domain prefix + the
 * stored argon2 hash. Changing the password changes the hash, so every
 * session signed in before the change stops matching. Domain-separated from
 * login-link-token.ts's credentialFingerprint (no prefix, hex).
 */
export function sessionCredentialFingerprint(passwordHash: string): string {
  return createHash('sha256')
    .update(SESSION_CFP_DOMAIN + passwordHash, 'utf8')
    .digest('base64url');
}

// ─── TTL ──────────────────────────────────────────────────────────────────────

/**
 * sessionRevalidateTtlMs — AEROOPS_SESSION_REVALIDATE_TTL_MS as whole ms:
 * unset, blank, negative or not a number → the 15 s default; 0 → no cache;
 * above 5 min → 5 min. Read on every call, so tests can change it.
 */
export function sessionRevalidateTtlMs(): number {
  const raw = process.env[SESSION_REVALIDATE_TTL_ENV]?.trim();
  if (!raw) return DEFAULT_SESSION_REVALIDATE_TTL_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_SESSION_REVALIDATE_TTL_MS;
  return Math.min(Math.floor(ms), MAX_SESSION_REVALIDATE_TTL_MS);
}

// ─── Verdict (the database read) ──────────────────────────────────────────────

type Verdict = { ok: true; role: MembershipRole } | { ok: false };

const SIGNED_OUT: Verdict = { ok: false };

/**
 * loadVerdict — one query under withOrgContext(orgId): the membership row for
 * (orgId, userId), its org's status, and the credential hash. RLS plus the
 * explicit org_id predicates scope every table to orgId, so a user of
 * another org simply has no row here. The hash is used for the comparison
 * only and is not kept.
 */
async function loadVerdict(
  db: AnyDb,
  orgId: string,
  userId: string,
  cfp: string,
): Promise<Verdict> {
  const row = await withOrgContext(db, orgId, async (tx) => {
    const rows = await tx
      .select({
        role: membership.role,
        orgStatus: org.status,
        passwordHash: authCredential.passwordHash,
      })
      .from(membership)
      .innerJoin(org, eq(org.id, membership.orgId))
      .leftJoin(
        authCredential,
        and(eq(authCredential.userId, membership.userId), eq(authCredential.orgId, membership.orgId)),
      )
      .where(and(eq(membership.orgId, orgId), eq(membership.userId, userId)))
      .limit(1);
    return rows[0];
  });

  if (!row || !isMembershipRole(row.role) || row.orgStatus !== 'active') return SIGNED_OUT;
  if (row.passwordHash === null) return SIGNED_OUT;
  if (!fingerprintsMatch(sessionCredentialFingerprint(row.passwordHash), cfp)) return SIGNED_OUT;
  return { ok: true, role: row.role };
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  expiresAt: number;
  /** In flight or settled; concurrent callers share it. */
  verdict: Promise<Verdict>;
}

const verdictCache = new Map<string, CacheEntry>();

/** Drop expired entries, then the oldest, until there is room for one more. */
function makeRoom(now: number): void {
  if (verdictCache.size < SESSION_REVALIDATE_CACHE_MAX_ENTRIES) return;
  for (const [key, entry] of verdictCache) {
    if (entry.expiresAt <= now) verdictCache.delete(key);
  }
  // A Map iterates in insertion order, so this drops the oldest first.
  for (const key of verdictCache.keys()) {
    if (verdictCache.size < SESSION_REVALIDATE_CACHE_MAX_ENTRIES) break;
    verdictCache.delete(key);
  }
}

function cachedVerdict(key: string, load: () => Promise<Verdict>): Promise<Verdict> {
  const ttlMs = sessionRevalidateTtlMs();
  if (ttlMs === 0) return load();

  const now = Date.now();
  const hit = verdictCache.get(key);
  if (hit && hit.expiresAt > now) return hit.verdict;
  if (hit) verdictCache.delete(key);

  const entry: CacheEntry = { expiresAt: now + ttlMs, verdict: load() };
  makeRoom(now);
  verdictCache.set(key, entry);
  // Only a good verdict is kept once settled. A signed-out verdict (see CACHE
  // in the header) or a failed check is dropped: the next call asks the
  // database again.
  const forget = (): void => {
    if (verdictCache.get(key) === entry) verdictCache.delete(key);
  };
  entry.verdict.then((verdict) => {
    if (!verdict.ok) forget();
  }, forget);
  return entry.verdict;
}

/** Test hook: forget every cached verdict. */
export function clearSessionRevalidationCache(): void {
  verdictCache.clear();
}

// ─── Revalidation ─────────────────────────────────────────────────────────────

type SessionToken = Record<string, unknown>;

/**
 * logRevalidationFailure — error class + driver code (e.g. a Postgres SQLSTATE)
 * only. No message: a query error's message carries the SQL and its
 * parameters (the user and org ids), and nothing here needs them.
 */
function logRevalidationFailure(err: unknown): void {
  const codeOf = (e: unknown): unknown => (e as { code?: unknown } | null | undefined)?.code;
  const name = err instanceof Error ? err.name : typeof err;
  // Drizzle wraps the driver error as `cause`; postgres-js puts `code` on the error itself.
  const code = codeOf(err instanceof Error ? err.cause : undefined) ?? codeOf(err);
  console.error(
    `[auth] session check failed (${name}${typeof code === 'string' ? ` ${code}` : ''}); ` +
      'treating the request as signed out',
  );
}

/**
 * revalidateSessionToken — the token (role replaced by the DB role when they
 * differ) if the session is still good, otherwise null. Never throws.
 * resolveDb runs only on a cache miss.
 */
async function revalidateSessionToken(
  token: SessionToken,
  resolveDb: () => Promise<AnyDb>,
): Promise<SessionToken | null> {
  const userId = token['userId'];
  const orgId = token['orgId'];
  const cfp = token['cfp'];
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) return null;
  if (typeof orgId !== 'string' || !UUID_RE.test(orgId)) return null;
  // Issued before sessions were revalidated: fail closed (sign in once more).
  if (typeof cfp !== 'string' || cfp === '') return null;

  let verdict: Verdict;
  try {
    verdict = await cachedVerdict(`${orgId}:${userId}:${cfp}`, async () =>
      loadVerdict(await resolveDb(), orgId, userId, cfp),
    );
  } catch (err) {
    logRevalidationFailure(err);
    return null;
  }

  if (!verdict.ok) return null;
  // The database is the source of truth for the role.
  return token['role'] === verdict.role ? token : { ...token, role: verdict.role };
}

// ─── The Node jwt callback ────────────────────────────────────────────────────

/**
 * createSessionJwtCallback — the jwt callback for buildAuthConfig() (the Node
 * config every server-side auth() runs). NOT for the edge config.
 *
 * Field projection is the shared jwtCallback, so the Node and edge configs
 * can never drift on what the token carries. On sign-in (`user` present)
 * authorize() has just verified the password and read the role and
 * fingerprint, so the token is returned as is; every later read is
 * revalidated against the database that resolveDb returns.
 *
 * @param resolveDb - getDb in production; tests pass their PGlite client.
 */
export function createSessionJwtCallback(
  resolveDb: () => Promise<AnyDb>,
): (params: { token: SessionToken; user?: unknown }) => Promise<SessionToken | null> {
  return async function sessionJwtCallback({ token, user }) {
    const projected: SessionToken = await jwtCallback({ token, user });
    if (user) return projected;
    return revalidateSessionToken(projected, resolveDb);
  };
}
