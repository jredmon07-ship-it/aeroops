/**
 * login-link-token.test.ts — unit tests for the stateless login-link token.
 *
 * No database. Covers: round-trip, tamper, wrong secret, expiry, wrong
 * purpose, a mobile token presented as a link (and vice versa), placeholder
 * secret refusal, and the credential fingerprint (match / mismatch / reuse
 * after a password change).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { encode } from 'next-auth/jwt';
import {
  signLoginLinkToken,
  verifyLoginLinkToken,
  credentialFingerprint,
  fingerprintsMatch,
  LOGIN_LINK_MAX_AGE_SECONDS,
  LOGIN_LINK_PURPOSE,
} from '../auth/login-link-token.js';
import { signMobileToken, verifyMobileToken } from '../auth/mobile-token.js';

const TEST_SECRET = 'login-link-token-test-secret-32b!!';
const OTHER_SECRET = 'some-other-deployment-secret-32b!!';

const CLAIMS = {
  userId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  fp: credentialFingerprint(null),
  by: '33333333-3333-4333-8333-333333333333',
  role: 'renter',
};

let originalSecret: string | undefined;

beforeAll(() => {
  originalSecret = process.env['AUTH_SECRET'];
  process.env['AUTH_SECRET'] = TEST_SECRET;
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env['AUTH_SECRET'];
  else process.env['AUTH_SECRET'] = originalSecret;
});

afterEach(() => {
  vi.useRealTimers();
  process.env['AUTH_SECRET'] = TEST_SECRET;
});

describe('signLoginLinkToken / verifyLoginLinkToken', () => {
  it('round-trips the claims', async () => {
    const token = await signLoginLinkToken(CLAIMS);
    expect(await verifyLoginLinkToken(token)).toEqual(CLAIMS);
  });

  it('is URL-path safe (no "/", "?", "#", or whitespace)', async () => {
    const token = await signLoginLinkToken(CLAIMS);
    expect(token).toMatch(/^[A-Za-z0-9_.-]+$/);
  });

  it('rejects a tampered token', async () => {
    const token = await signLoginLinkToken(CLAIMS);
    const parts = token.split('.');
    // Flip one character in the ciphertext segment.
    const ct = parts[3]!;
    parts[3] = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    expect(await verifyLoginLinkToken(parts.join('.'))).toBeNull();
    expect(await verifyLoginLinkToken(token.slice(0, -2))).toBeNull();
  });

  it('rejects garbage and empty input', async () => {
    expect(await verifyLoginLinkToken('not-a-token')).toBeNull();
    expect(await verifyLoginLinkToken('')).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    process.env['AUTH_SECRET'] = OTHER_SECRET;
    const foreign = await signLoginLinkToken(CLAIMS);
    process.env['AUTH_SECRET'] = TEST_SECRET;
    expect(await verifyLoginLinkToken(foreign)).toBeNull();
  });

  it('rejects an expired token (7 days)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-01T12:00:00Z');
    vi.setSystemTime(start);
    const token = await signLoginLinkToken(CLAIMS);

    // Just inside the window → valid.
    vi.setSystemTime(new Date(start.getTime() + (LOGIN_LINK_MAX_AGE_SECONDS - 60) * 1000));
    expect(await verifyLoginLinkToken(token)).toEqual(CLAIMS);

    // Past the window (beyond jose's 15 s clock tolerance) → dead.
    vi.setSystemTime(new Date(start.getTime() + (LOGIN_LINK_MAX_AGE_SECONDS + 60) * 1000));
    expect(await verifyLoginLinkToken(token)).toBeNull();
  });

  it('rejects a token with the right key but the wrong purpose', async () => {
    // Same secret AND same salt as a real link — only the purpose differs.
    const wrongPurpose = await encode({
      token: { purpose: 'password-reset-v0', userId: CLAIMS.userId, orgId: CLAIMS.orgId, fp: CLAIMS.fp },
      secret: TEST_SECRET,
      salt: 'aeroops.login-link',
      maxAge: 60,
    });
    expect(await verifyLoginLinkToken(wrongPurpose)).toBeNull();

    const noPurpose = await encode({
      token: { userId: CLAIMS.userId, orgId: CLAIMS.orgId, fp: CLAIMS.fp },
      secret: TEST_SECRET,
      salt: 'aeroops.login-link',
      maxAge: 60,
    });
    expect(await verifyLoginLinkToken(noPurpose)).toBeNull();
    expect(LOGIN_LINK_PURPOSE).toBe('login-link');
  });

  it('rejects a token missing a required claim', async () => {
    const missingFp = await encode({
      token: { purpose: LOGIN_LINK_PURPOSE, userId: CLAIMS.userId, orgId: CLAIMS.orgId },
      secret: TEST_SECRET,
      salt: 'aeroops.login-link',
      maxAge: 60,
    });
    expect(await verifyLoginLinkToken(missingFp)).toBeNull();

    // A token minted without the creator / target-role claims (the shape
    // before the accept-time privilege re-check) is refused outright.
    const missingByRole = await encode({
      token: { purpose: LOGIN_LINK_PURPOSE, userId: CLAIMS.userId, orgId: CLAIMS.orgId, fp: CLAIMS.fp },
      secret: TEST_SECRET,
      salt: 'aeroops.login-link',
      maxAge: 60,
    });
    expect(await verifyLoginLinkToken(missingByRole)).toBeNull();
  });

  it('a mobile access token (same secret) is never accepted as a login link', async () => {
    const mobile = await signMobileToken({
      userId: CLAIMS.userId,
      orgId: CLAIMS.orgId,
      slug: 'alpha',
      role: 'owner',
      email: 'alice@alpha.example',
    });
    expect(await verifyLoginLinkToken(mobile)).toBeNull();
  });

  it('a web-session-shaped token carrying purpose=login-link is still rejected (wrong salt)', async () => {
    const sessionSalted = await encode({
      token: { purpose: LOGIN_LINK_PURPOSE, ...CLAIMS },
      secret: TEST_SECRET,
      salt: 'authjs.session-token',
      maxAge: 60,
    });
    expect(await verifyLoginLinkToken(sessionSalted)).toBeNull();
  });

  it('a login link is never accepted as a mobile/session token', async () => {
    const link = await signLoginLinkToken(CLAIMS);
    expect(await verifyMobileToken(link)).toBeNull();
  });

  it('refuses to mint or verify with the build-time placeholder secret', async () => {
    process.env['AUTH_SECRET'] = 'build-time-placeholder-not-a-real-secret-replace-me';
    await expect(signLoginLinkToken(CLAIMS)).rejects.toThrow('AUTH_SECRET');
    await expect(verifyLoginLinkToken('x')).rejects.toThrow('AUTH_SECRET');
  });

  it('refuses to mint when AUTH_SECRET is unset', async () => {
    delete process.env['AUTH_SECRET'];
    await expect(signLoginLinkToken(CLAIMS)).rejects.toThrow('AUTH_SECRET');
  });
});

describe('credentialFingerprint', () => {
  const HASH_1 = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaDE';
  const HASH_2 = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaDI';

  it('is deterministic and hex', () => {
    expect(credentialFingerprint(HASH_1)).toBe(credentialFingerprint(HASH_1));
    expect(credentialFingerprint(HASH_1)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not contain the hash it was made from', () => {
    expect(credentialFingerprint(HASH_1)).not.toContain('argon2');
  });

  it('differs for no-credential vs a credential, and between two hashes', () => {
    expect(credentialFingerprint(null)).toBe(credentialFingerprint(undefined));
    expect(credentialFingerprint(null)).not.toBe(credentialFingerprint(HASH_1));
    expect(credentialFingerprint(HASH_1)).not.toBe(credentialFingerprint(HASH_2));
  });

  it('fingerprintsMatch: equal → true; mismatch / reuse after a change → false', () => {
    const atLinkTime = credentialFingerprint(null); // invite link
    expect(fingerprintsMatch(atLinkTime, credentialFingerprint(null))).toBe(true);
    // Password got set → the old link's fingerprint no longer matches.
    expect(fingerprintsMatch(atLinkTime, credentialFingerprint(HASH_1))).toBe(false);
    // A reset link made for HASH_1 dies once the hash becomes HASH_2.
    expect(fingerprintsMatch(credentialFingerprint(HASH_1), credentialFingerprint(HASH_2))).toBe(false);
    // Length mismatch never throws.
    expect(fingerprintsMatch('abc', atLinkTime)).toBe(false);
  });
});
