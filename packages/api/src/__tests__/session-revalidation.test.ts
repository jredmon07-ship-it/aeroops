/**
 * session-revalidation.test.ts — web sessions follow password resets, role
 * changes and removals (auth/session-revalidation.ts), against PGlite with the
 * full migration chain and RLS enforced (setTestAppRole).
 *
 * The callback under test is the REAL one: buildAuthConfig({ resolveDb })'s
 * jwt callback with the PGlite client injected. Sign-in runs the config's own
 * authorize() and then jwt({ token, user }) the way Auth.js's credentials
 * callback does; a "request" is jwt({ token }), which is what Auth.js's
 * session action runs for every server-side auth(). S11 goes through the
 * installed Auth.js itself.
 *
 * COVERAGE:
 *   S1 — sign-in: claims and token carry cfp (a domain-separated digest — not
 *        the hash, not the login-link fingerprint); the sign-in jwt call does
 *        not query; a matching cfp gets the same token back.
 *   S2 — password set through a login link → the old token is refused on its
 *        next request (TTL 0); the new password signs in and works.
 *   S3 — token without cfp (issued before this shipped), an empty or foreign
 *        cfp, malformed ids → refused; the shape checks run no query.
 *   S4 — membership removed → refused.
 *   S5 — role demoted → the token carries the DB role and a people:manage
 *        action with that session is refused (it was allowed before);
 *        a promotion applies the same way.
 *   S6 — cross-org: a token naming another org than the member's → refused.
 *   S7 — org suspended → refused; reactivated → accepted again.
 *   S8 — cache: one query for repeated and concurrent checks within the TTL;
 *        a reset or role change applies once the TTL lapses; signing in again
 *        after a reset is not held up; TTL 0 queries every time; bounded size;
 *        the env var's parsing.
 *   S9 — database errors fail closed, are logged without ids or emails and
 *        are not cached; a db resolver that throws also fails closed.
 *   S10 — wiring: buildAuthConfig's jwt callback revalidates, the edge
 *        config's is the pure jwtCallback; cfp never reaches the session object
 *        or the mobile token.
 *   S11 — the installed Auth.js (@auth/core Auth(), which next-auth's handlers,
 *        middleware and auth() all call): a real credentials sign-in sets a
 *        cookie carrying cfp; the Node config returns the session; the edge
 *        config re-issues the cookie with cfp intact; after a reset the Node
 *        config answers null and clears the cookie — so auth() returns null —
 *        while the edge config still accepts it (the redirect-loop premise).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { decode } from 'next-auth/jwt';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  loadMigrationSql,
  seedAuthCredential,
  appUser,
  membership,
  org,
} from '@aeroops/db';
import type { PgliteTestClient, AnyDb } from '@aeroops/db';
import type { MembershipRole } from '@aeroops/core';

import {
  sessionCredentialFingerprint,
  sessionRevalidateTtlMs,
  clearSessionRevalidationCache,
  SESSION_REVALIDATE_TTL_ENV,
  DEFAULT_SESSION_REVALIDATE_TTL_MS,
  MAX_SESSION_REVALIDATE_TTL_MS,
  SESSION_REVALIDATE_CACHE_MAX_ENTRIES,
} from '../auth/session-revalidation.js';
import { buildAuthConfig, buildEdgeAuthConfig, jwtCallback, sessionCallback } from '../auth/auth-config.js';
import { verifyLoginAndIssueClaimsWithDb } from '../auth/verify-login.js';
import { credentialFingerprint } from '../auth/login-link-token.js';
import { signMobileToken } from '../auth/mobile-token.js';
import { hashPassword } from '../auth/hash.js';
import { ForbiddenError } from '../auth/require-capability.js';
import { createLoginLinkWithDb, acceptLoginLinkWithDb } from '../people/login-link.js';
import { updateMemberWithDb } from '../people/update-member.js';
import type { AppSession } from '../auth/types.js';

const MIGRATION_SQL = loadMigrationSql('0050');
const TEST_SECRET = 'session-revalidation-test-secret-32b!';
/** Auth.js's session cookie name (and JWE salt) on an http:// origin. */
const SESSION_COOKIE = 'authjs.session-token';

let db: PgliteTestClient;
let pglite: PGlite;
let orgAId: string;
let orgBId: string;
let ownerAId: string;
let originalSecret: string | undefined;
let originalTtl: string | undefined;

type Token = Record<string, any>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ownerA = (): AppSession => ({
  userId: ownerAId,
  orgId: orgAId,
  slug: 'alpha',
  role: 'owner',
  user: { email: 'alice@alpha.example' },
});

let seq = 0;
/** A member with a password, in the given org. */
async function seedMemberWithPassword(
  orgId: string,
  role: MembershipRole,
  password: string,
): Promise<{ id: string; email: string; hash: string }> {
  seq++;
  const email = `s${seq}-${role}@session-check.example`;
  const id = await withOrgContext(db, orgId, async (tx) => {
    const [u] = await tx.insert(appUser).values({ orgId, email, fullName: `Session ${seq}` }).returning();
    await tx.insert(membership).values({ orgId, userId: u!.id, role });
    return u!.id;
  });
  const hash = await hashPassword(password);
  await seedAuthCredential(db, orgId, id, hash);
  return { id, email, hash };
}

/** The real Node config, reading from `d`. */
function nodeConfig(d: AnyDb = db): any {
  return buildAuthConfig({ resolveDb: async () => d });
}

/**
 * signIn — what Auth.js's credentials callback does (@auth/core 0.41.2
 * lib/actions/callback/index.js): authorize(), then jwt({ token, user }).
 * Credentials() keeps our authorize under `options` (providers/credentials.js).
 */
async function signIn(email: string, password: string, slug = 'alpha', config = nodeConfig()): Promise<Token> {
  const user = await config.providers[0].options.authorize({ slug, email, password });
  if (!user) throw new Error(`sign-in refused for ${email}`);
  const token = await config.callbacks.jwt({
    token: { name: user.name, email: user.email, picture: user.image, sub: user.id },
    user,
    account: { providerAccountId: user.id, type: 'credentials', provider: 'credentials' },
    isNewUser: false,
    trigger: 'signIn',
  });
  return token as Token;
}

/** One server-side auth() worth of revalidation: jwt({ token }) with no user. */
async function request(token: Token, d: AnyDb = db): Promise<Token | null> {
  return nodeConfig(d).callbacks.jwt({ token: { ...token } });
}

/** The session object auth() would hand the app for this token. */
async function sessionOf(token: Token): Promise<AppSession> {
  return sessionCallback({
    session: { user: { name: token['name'], email: token['email'], image: token['picture'] }, expires: '2099-01-01T00:00:00.000Z' },
    token,
  });
}

/** Counts transactions — every session check is exactly one. */
function countingDb(inner: AnyDb): { db: AnyDb; count: () => number } {
  let n = 0;
  const proxy = new Proxy(inner as object, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (...args: unknown[]) => {
          n += 1;
          return (target as Record<string, (...a: unknown[]) => unknown>)['transaction']!(...args);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { db: proxy as AnyDb, count: () => n };
}

async function resetPasswordViaLink(userId: string, password: string): Promise<void> {
  const link = await createLoginLinkWithDb(db, ownerA(), { userId });
  if (!link.ok) throw new Error(`createLoginLink refused: ${link.reason}`);
  const token = link.path.split('/').pop()!;
  const accepted = await acceptLoginLinkWithDb(db, { slug: 'alpha', token, password });
  if (!accepted.ok) throw new Error('acceptLoginLink refused');
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  originalSecret = process.env['AUTH_SECRET'];
  originalTtl = process.env[SESSION_REVALIDATE_TTL_ENV];
  process.env['AUTH_SECRET'] = TEST_SECRET;

  ({ db, pglite } = await createTestClient());
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  orgAId = seed.orgAId;
  orgBId = seed.orgBId;
  ownerAId = seed.userAId;
  await setTestAppRole({ pglite });
}, 60_000);

beforeEach(() => {
  // No cache unless a test opts in, so each check below hits the database.
  process.env[SESSION_REVALIDATE_TTL_ENV] = '0';
  clearSessionRevalidationCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env['AUTH_SECRET'];
  else process.env['AUTH_SECRET'] = originalSecret;
  if (originalTtl === undefined) delete process.env[SESSION_REVALIDATE_TTL_ENV];
  else process.env[SESSION_REVALIDATE_TTL_ENV] = originalTtl;
  clearSessionRevalidationCache();
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('S1 — sign-in carries cfp; a matching cfp passes', () => {
  it('the login claims carry a domain-separated digest — not the hash, not the login-link fingerprint', async () => {
    const m = await seedMemberWithPassword(orgAId, 'dispatcher', 's1-password-1');
    const claims = await verifyLoginAndIssueClaimsWithDb(db, { slug: 'alpha', email: m.email, password: 's1-password-1' });
    expect(claims).not.toBeNull();
    expect(claims!.cfp).toBe(sessionCredentialFingerprint(m.hash));
    expect(claims!.cfp).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url sha256
    expect(claims!.cfp).not.toContain(m.hash);
    expect(claims!.cfp).not.toBe(credentialFingerprint(m.hash));
  });

  it('sign-in puts cfp on the token without a query; the next request gets the same token back', async () => {
    const m = await seedMemberWithPassword(orgAId, 'dispatcher', 's1-password-2');
    const counter = countingDb(db);
    const config = nodeConfig(counter.db);
    const user = await config.providers[0].options.authorize({ slug: 'alpha', email: m.email, password: 's1-password-2' });
    expect(user).toMatchObject({ id: m.id, orgId: orgAId, slug: 'alpha', role: 'dispatcher', cfp: sessionCredentialFingerprint(m.hash) });

    const queriesBefore = counter.count();
    const token = await config.callbacks.jwt({ token: { email: user.email, sub: user.id }, user, trigger: 'signIn' });
    expect(counter.count()).toBe(queriesBefore); // sign-in is not re-checked
    expect(token).toMatchObject({ userId: m.id, orgId: orgAId, slug: 'alpha', role: 'dispatcher', cfp: user.cfp });

    const next = await config.callbacks.jwt({ token: { ...token } });
    expect(counter.count()).toBe(queriesBefore + 1);
    expect(next).toEqual(token);
  });
});

describe('S2 — a password reset ends sessions signed in before it', () => {
  it('a password set through a login link refuses the old token on its next request; the new password works', async () => {
    const m = await seedMemberWithPassword(orgAId, 'cfi', 's2-old-password');
    const oldToken = await signIn(m.email, 's2-old-password');
    expect(await request(oldToken)).toMatchObject({ userId: m.id, role: 'cfi' });

    await resetPasswordViaLink(m.id, 's2-new-password');

    expect(await request(oldToken)).toBeNull();
    expect(await request(oldToken)).toBeNull(); // and stays refused

    const newToken = await signIn(m.email, 's2-new-password');
    expect(newToken['cfp']).not.toBe(oldToken['cfp']);
    expect(await request(newToken)).toMatchObject({ userId: m.id, role: 'cfi' });
  });
});

describe('S3 — tokens without a usable cfp or ids', () => {
  it('a token issued before cfp existed is refused without touching the database', async () => {
    const m = await seedMemberWithPassword(orgAId, 'renter', 's3-password-1');
    const token = await signIn(m.email, 's3-password-1');
    const { cfp: _cfp, ...legacy } = token;
    const counter = countingDb(db);

    expect(await request(legacy, counter.db)).toBeNull();
    expect(await request({ ...token, cfp: '' }, counter.db)).toBeNull();
    expect(await request({ ...token, cfp: 42 }, counter.db)).toBeNull();
    expect(await request({ ...token, userId: 'not-a-uuid' }, counter.db)).toBeNull();
    expect(await request({ ...token, orgId: undefined }, counter.db)).toBeNull();
    expect(counter.count()).toBe(0);

    // The same token with its cfp is fine.
    expect(await request(token, counter.db)).not.toBeNull();
  });

  it('a cfp that is not the current credential\'s is refused', async () => {
    const m = await seedMemberWithPassword(orgAId, 'renter', 's3-password-2');
    const token = await signIn(m.email, 's3-password-2');
    expect(await request({ ...token, cfp: sessionCredentialFingerprint('$argon2id$some-other-hash') })).toBeNull();
    // The raw login-link fingerprint of the SAME hash is not a session cfp either.
    expect(await request({ ...token, cfp: credentialFingerprint(m.hash) })).toBeNull();
  });
});

describe('S4 — membership removed', () => {
  it('removing the member from the org ends their session', async () => {
    const m = await seedMemberWithPassword(orgAId, 'mechanic', 's4-password-1');
    const token = await signIn(m.email, 's4-password-1');
    expect(await request(token)).not.toBeNull();

    await withOrgContext(db, orgAId, (tx) =>
      tx.delete(membership).where(and(eq(membership.orgId, orgAId), eq(membership.userId, m.id))),
    );

    expect(await request(token)).toBeNull();
  });
});

describe('S5 — role changes apply to the live session', () => {
  it('a demoted manager gets the DB role, and a people:manage action is refused with it', async () => {
    const manager = await seedMemberWithPassword(orgAId, 'manager', 's5-password-1');
    const renter = await seedMemberWithPassword(orgAId, 'renter', 's5-password-2');
    const token = await signIn(manager.email, 's5-password-1');

    const before = await request(token);
    expect(before!['role']).toBe('manager');
    // people:manage works while they are a manager …
    expect((await createLoginLinkWithDb(db, await sessionOf(before!), { userId: renter.id })).ok).toBe(true);

    const demoted = await updateMemberWithDb(db, ownerA(), { userId: manager.id, role: 'dispatcher' });
    expect(demoted.ok).toBe(true);

    // … and the SAME cookie now carries the membership's role.
    const after = await request(token);
    expect(after).not.toBeNull();
    expect(after!['role']).toBe('dispatcher');
    expect(token['role']).toBe('manager');
    const session = await sessionOf(after!);
    expect(session.role).toBe('dispatcher');
    await expect(createLoginLinkWithDb(db, session, { userId: renter.id })).rejects.toThrow(ForbiddenError);
  });

  it('a promotion applies the same way', async () => {
    const m = await seedMemberWithPassword(orgAId, 'student', 's5-password-3');
    const token = await signIn(m.email, 's5-password-3');
    const promoted = await updateMemberWithDb(db, ownerA(), { userId: m.id, role: 'cfi' });
    expect(promoted.ok).toBe(true);
    expect((await request(token))!['role']).toBe('cfi');
  });
});

describe('S6 — cross-org', () => {
  it('a token naming another org than the member belongs to is refused', async () => {
    const a = await seedMemberWithPassword(orgAId, 'dispatcher', 's6-password-a');
    const b = await seedMemberWithPassword(orgBId, 'dispatcher', 's6-password-b');
    const tokenA = await signIn(a.email, 's6-password-a', 'alpha');
    const tokenB = await signIn(b.email, 's6-password-b', 'beta');
    expect(await request(tokenA)).toMatchObject({ orgId: orgAId });
    expect(await request(tokenB)).toMatchObject({ orgId: orgBId });

    expect(await request({ ...tokenA, orgId: orgBId, slug: 'beta' })).toBeNull();
    expect(await request({ ...tokenB, orgId: orgAId, slug: 'alpha' })).toBeNull();
  });
});

describe('S7 — org suspended', () => {
  it('suspending the org ends its sessions; reactivating it lets them back in', async () => {
    const m = await seedMemberWithPassword(orgBId, 'dispatcher', 's7-password-1');
    const token = await signIn(m.email, 's7-password-1', 'beta');
    expect(await request(token)).not.toBeNull();

    await withOrgContext(db, orgBId, (tx) => tx.update(org).set({ status: 'suspended' }).where(eq(org.id, orgBId)));
    try {
      expect(await request(token)).toBeNull();
    } finally {
      await withOrgContext(db, orgBId, (tx) => tx.update(org).set({ status: 'active' }).where(eq(org.id, orgBId)));
    }
    expect(await request(token)).not.toBeNull();
  });
});

describe('S8 — cache', () => {
  it('within the TTL, repeated and concurrent checks of one session share one query', async () => {
    process.env[SESSION_REVALIDATE_TTL_ENV] = '60000';
    const m = await seedMemberWithPassword(orgAId, 'dispatcher', 's8-password-1');
    const token = await signIn(m.email, 's8-password-1');
    const counter = countingDb(db);

    // One page render: several auth() calls at once.
    const results = await Promise.all(Array.from({ length: 5 }, () => request(token, counter.db)));
    expect(results.every((r) => r?.['userId'] === m.id)).toBe(true);
    expect(counter.count()).toBe(1);

    // A later request inside the TTL.
    expect(await request(token, counter.db)).not.toBeNull();
    expect(counter.count()).toBe(1);
  });

  it('TTL 0 disables the cache: every check queries', async () => {
    const m = await seedMemberWithPassword(orgAId, 'dispatcher', 's8-password-2');
    const token = await signIn(m.email, 's8-password-2');
    const counter = countingDb(db);
    for (let i = 0; i < 3; i++) expect(await request(token, counter.db)).not.toBeNull();
    expect(counter.count()).toBe(3);
  });

  it('a reset applies once the TTL lapses, and signing in again with the new password is not held up', async () => {
    process.env[SESSION_REVALIDATE_TTL_ENV] = '15000';
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-10-14T12:00:00.000Z').getTime();
    vi.setSystemTime(t0);

    const m = await seedMemberWithPassword(orgAId, 'cfi', 's8-old-password');
    const oldToken = await signIn(m.email, 's8-old-password');
    expect(await request(oldToken)).not.toBeNull(); // cached at t0

    await resetPasswordViaLink(m.id, 's8-new-password');

    // Within the TTL the cached verdict for the old cookie still stands …
    vi.setSystemTime(t0 + 10_000);
    expect(await request(oldToken)).not.toBeNull();
    // … the new password's session is checked under its own key, so it works at once …
    const newToken = await signIn(m.email, 's8-new-password');
    expect(await request(newToken)).not.toBeNull();
    // … and once the TTL has lapsed the old cookie is refused.
    vi.setSystemTime(t0 + 15_001);
    expect(await request(oldToken)).toBeNull();
    expect(await request(newToken)).not.toBeNull();
  });

  it('a role change applies once the TTL lapses', async () => {
    process.env[SESSION_REVALIDATE_TTL_ENV] = '15000';
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-10-14T13:00:00.000Z').getTime();
    vi.setSystemTime(t0);

    const m = await seedMemberWithPassword(orgAId, 'manager', 's8-password-3');
    const token = await signIn(m.email, 's8-password-3');
    expect((await request(token))!['role']).toBe('manager');

    expect((await updateMemberWithDb(db, ownerA(), { userId: m.id, role: 'renter' })).ok).toBe(true);
    vi.setSystemTime(t0 + 14_999);
    expect((await request(token))!['role']).toBe('manager');
    vi.setSystemTime(t0 + 15_000);
    expect((await request(token))!['role']).toBe('renter');
  });

  it('the cache is bounded: past the limit the oldest verdict is dropped', async () => {
    process.env[SESSION_REVALIDATE_TTL_ENV] = '60000';
    // A db whose every transaction finds nothing (signed out), and counts.
    let queries = 0;
    const emptyDb = { transaction: async () => { queries += 1; return undefined; } } as unknown as AnyDb;
    const tokens = Array.from({ length: SESSION_REVALIDATE_CACHE_MAX_ENTRIES + 1 }, () => ({
      userId: randomUUID(),
      orgId: orgAId,
      slug: 'alpha',
      role: 'renter',
      cfp: 'cfp-of-a-member-that-does-not-exist',
    }));

    for (const t of tokens) expect(await request(t, emptyDb)).toBeNull();
    expect(queries).toBe(SESSION_REVALIDATE_CACHE_MAX_ENTRIES + 1);

    // The newest verdict is still cached …
    expect(await request(tokens[SESSION_REVALIDATE_CACHE_MAX_ENTRIES]!, emptyDb)).toBeNull();
    expect(queries).toBe(SESSION_REVALIDATE_CACHE_MAX_ENTRIES + 1);
    // … the oldest was dropped to make room.
    expect(await request(tokens[0]!, emptyDb)).toBeNull();
    expect(queries).toBe(SESSION_REVALIDATE_CACHE_MAX_ENTRIES + 2);
  });

  it('reads AEROOPS_SESSION_REVALIDATE_TTL_MS: default, 0, whole ms, cap, junk', () => {
    const cases: Array<[string | undefined, number]> = [
      [undefined, DEFAULT_SESSION_REVALIDATE_TTL_MS],
      ['', DEFAULT_SESSION_REVALIDATE_TTL_MS],
      ['  ', DEFAULT_SESSION_REVALIDATE_TTL_MS],
      ['0', 0],
      ['2500', 2500],
      ['2500.9', 2500],
      ['-1', DEFAULT_SESSION_REVALIDATE_TTL_MS],
      ['15s', DEFAULT_SESSION_REVALIDATE_TTL_MS],
      ['86400000', MAX_SESSION_REVALIDATE_TTL_MS],
    ];
    for (const [raw, expected] of cases) {
      if (raw === undefined) delete process.env[SESSION_REVALIDATE_TTL_ENV];
      else process.env[SESSION_REVALIDATE_TTL_ENV] = raw;
      expect(sessionRevalidateTtlMs(), `env=${JSON.stringify(raw)}`).toBe(expected);
    }
    expect(DEFAULT_SESSION_REVALIDATE_TTL_MS).toBe(15_000);
  });
});

describe('S9 — database errors fail closed', () => {
  it('a failed check returns null, logs no ids or emails, and is not cached', async () => {
    process.env[SESSION_REVALIDATE_TTL_ENV] = '60000';
    const m = await seedMemberWithPassword(orgAId, 'dispatcher', 's9-password-1');
    const token = await signIn(m.email, 's9-password-1');
    const failingDb = new Proxy(db as object, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return () =>
            Promise.reject(
              Object.assign(new Error(`connection lost while reading ${m.id} ${m.email} in ${orgAId}`), {
                code: '08006',
              }),
            );
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as AnyDb;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await request(token, failingDb)).toBeNull();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('session check failed');
    expect(logged).toContain('08006');
    expect(logged).not.toContain(m.id);
    expect(logged).not.toContain(m.email);
    expect(logged).not.toContain(orgAId);

    // The failure was not cached: with the database back, the same cookie works.
    expect(await request(token)).toMatchObject({ userId: m.id });
  });

  it('a db resolver that throws (e.g. DATABASE_URL unset) fails closed too', async () => {
    const m = await seedMemberWithPassword(orgAId, 'dispatcher', 's9-password-2');
    const token = await signIn(m.email, 's9-password-2');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = buildAuthConfig({
      resolveDb: async () => {
        throw new Error('[createProdClient] DATABASE_URL is not set');
      },
    });

    expect(await broken.callbacks.jwt({ token: { ...token } })).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('S10 — wiring', () => {
  it('buildAuthConfig revalidates; the edge config keeps the pure, db-free jwtCallback', () => {
    const full = buildAuthConfig();
    expect(full.callbacks.jwt).not.toBe(jwtCallback);
    expect(full.callbacks.session).toBe(sessionCallback);
    const edge = buildEdgeAuthConfig();
    expect(edge.callbacks.jwt).toBe(jwtCallback);
    expect(edge.callbacks.session).toBe(sessionCallback);
  });

  it('cfp never reaches the session object, including next-auth\'s server-side auth() shape', async () => {
    const m = await seedMemberWithPassword(orgAId, 'dispatcher', 's10-password-1');
    const token = await signIn(m.email, 's10-password-1');
    const cfp = token['cfp'] as string;
    expect(cfp).toBeTruthy();

    const session = await sessionOf(token);
    expect(session).toMatchObject({ userId: m.id, orgId: orgAId, slug: 'alpha', role: 'dispatcher' });
    expect(JSON.stringify(session)).not.toContain(cfp);

    // next-auth 5.0.0-beta.31 lib/index.js: server-side auth() returns
    // { user: token, ...session } — our session.user must win.
    const serverSide = Object.assign({ user: token }, session);
    expect(serverSide.user).toBe(session.user);
    expect(JSON.stringify(serverSide)).not.toContain(cfp);
  });

  it('the mobile access token never carries cfp', async () => {
    const m = await seedMemberWithPassword(orgAId, 'renter', 's10-password-2');
    const claims = await verifyLoginAndIssueClaimsWithDb(db, { slug: 'alpha', email: m.email, password: 's10-password-2' });
    expect(claims!.cfp).toBeTruthy();
    const payload = await decode({ token: await signMobileToken(claims!), secret: TEST_SECRET, salt: SESSION_COOKIE });
    expect(payload).toMatchObject({ userId: m.id, orgId: orgAId });
    expect(payload).not.toHaveProperty('cfp');
  });
});

// ─── S11 — the installed Auth.js ─────────────────────────────────────────────

interface AuthCore {
  Auth: (request: Request, config: any) => Promise<Response>;
  setEnvDefaults: (env: Record<string, string | undefined>, config: any, suppressBasePathWarning?: boolean) => void;
}

/**
 * @auth/core is next-auth's dependency, not ours: load the exact copy
 * next-auth runs, from next-auth's own location. (next-auth's entry point
 * can't load under vitest — it imports `next/server`, which needs Next's
 * bundler — but its handlers, middleware wrapper and auth() all come down to
 * Auth(request, config), which is what these tests call.)
 */
async function loadAuthCore(): Promise<AuthCore> {
  const fromHere = createRequire(import.meta.url);
  const fromNextAuth = createRequire(fromHere.resolve('next-auth/package.json'));
  return (await import(pathToFileURL(fromNextAuth.resolve('@auth/core')).href)) as AuthCore;
}

const ORIGIN = 'http://localhost:3000';

/** name → value of each Set-Cookie on a response. */
function setCookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(';')[0]!;
    const i = pair.indexOf('=');
    out.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return out;
}

describe('S11 — through the installed Auth.js', () => {
  it('a reset makes the Node config answer null and clear the cookie; the edge config still accepts it', async () => {
    const { Auth, setEnvDefaults } = await loadAuthCore();
    // What next-auth does to a config before Auth() sees it (next-auth lib/env.js setEnvDefaults).
    const asNextAuth = (config: any): any => {
      const c = { ...config, basePath: '/api/auth' };
      setEnvDefaults(process.env, c, true);
      return c;
    };
    const node = asNextAuth(nodeConfig());
    const edge = asNextAuth(buildEdgeAuthConfig());
    const getSession = (config: any, cookie: string) =>
      Auth(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } }), config);
    // next-auth 5.0.0-beta.31 lib/index.js getSession(): every RSC / server-action auth() is this
    // request with the session callback wrapped, then `.then((r) => r.json())`.
    const serverAuth = async (cookie: string) => {
      const res = await Auth(
        new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } }),
        {
          ...node,
          callbacks: {
            ...node.callbacks,
            async session(...args: any[]) {
              const session = (await node.callbacks?.session?.(...args)) ?? {
                ...args[0].session,
                expires: args[0].session.expires?.toISOString?.() ?? args[0].session.expires,
              };
              const user = args[0].user ?? args[0].token;
              return { user, ...session };
            },
          },
        },
      );
      return res.json();
    };

    const m = await seedMemberWithPassword(orgAId, 'dispatcher', 's11-old-password');

    // 1. A real credentials sign-in: CSRF token, then POST the callback.
    const csrfRes = await Auth(new Request(`${ORIGIN}/api/auth/csrf`), node);
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const csrfCookie = setCookies(csrfRes).get('authjs.csrf-token');
    expect(csrfCookie).toBeTruthy();
    const signInRes = await Auth(
      new Request(`${ORIGIN}/api/auth/callback/credentials`, {
        method: 'POST',
        headers: { cookie: `authjs.csrf-token=${csrfCookie}` },
        body: new URLSearchParams({ csrfToken, slug: 'alpha', email: m.email, password: 's11-old-password' }),
      }),
      node,
    );
    expect(signInRes.status).toBe(302);
    const cookie = setCookies(signInRes).get(SESSION_COOKIE)!;
    expect(cookie).toBeTruthy();
    const claims = await decode({ token: cookie, secret: TEST_SECRET, salt: SESSION_COOKIE });
    expect(claims).toMatchObject({ userId: m.id, orgId: orgAId, slug: 'alpha', role: 'dispatcher' });
    const cfp = claims!['cfp'] as string;
    expect(cfp).toBe(sessionCredentialFingerprint(m.hash));

    // 2. auth() sees the session; cfp is not on it.
    const session = await serverAuth(cookie);
    expect(session).toMatchObject({ userId: m.id, orgId: orgAId, slug: 'alpha', role: 'dispatcher' });
    expect(JSON.stringify(session)).not.toContain(cfp);
    const viaHandler = await (await getSession(node, cookie)).json();
    expect(JSON.stringify(viaHandler)).not.toContain(cfp);

    // 3. The middleware's (edge) read re-issues the cookie with cfp intact,
    //    and the Node config accepts the re-issued cookie.
    const edgeRes = await getSession(edge, cookie);
    expect(((await edgeRes.json()) as Token | null)?.['userId']).toBe(m.id);
    const reissued = setCookies(edgeRes).get(SESSION_COOKIE)!;
    expect(reissued).toBeTruthy();
    expect((await decode({ token: reissued, secret: TEST_SECRET, salt: SESSION_COOKIE }))?.['cfp']).toBe(cfp);
    expect(await serverAuth(reissued)).toMatchObject({ userId: m.id });

    // 4. The member resets their password through a login link.
    await resetPasswordViaLink(m.id, 's11-new-password');

    // 5. Node config: null body — what auth() returns — and the cookie cleared.
    for (const c of [cookie, reissued]) {
      expect(await serverAuth(c)).toBeNull();
      const res = await getSession(node, c);
      expect(await res.json()).toBeNull();
      const cleared = res.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`));
      expect(cleared).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
      expect(cleared).toMatch(/Max-Age=0/i);
    }

    // 6. Edge config (middleware): still a signed-in visitor — it only checks
    //    the signature. Protected pages pass it through to a page whose auth()
    //    is null, which redirects to /o/alpha/login; the middleware lets that
    //    route through and the login page never redirects, so the revoked
    //    cookie lands there once.
    expect(((await (await getSession(edge, cookie)).json()) as Token | null)?.['userId']).toBe(m.id);
  });
});
