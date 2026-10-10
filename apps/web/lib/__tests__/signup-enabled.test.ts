/**
 * signup-enabled.test.ts — unit tests for the ALLOW_SIGNUP switch.
 *
 * COVERAGE:
 *
 *   1. isSignupEnabled is true ONLY for ALLOW_SIGNUP === 'true'
 *   2. Unset / empty / other truthy-looking strings are OFF (fail-closed)
 *   3. Defaults to reading process.env
 *   4. signupAction returns signup_disabled when OFF, WITHOUT reading headers
 *      or calling createOrgWithOwner (@aeroops/api + next/headers mocked)
 *   5. signupAction delegates to createOrgWithOwner when ON
 *
 * No DOM, no Next.js runtime, no DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above imports, so the spies must be too.
const { createOrgWithOwner, headers } = vi.hoisted(() => ({
  createOrgWithOwner: vi.fn(),
  headers: vi.fn(),
}));

vi.mock('@aeroops/api', () => ({ createOrgWithOwner }));
vi.mock('next/headers', () => ({ headers }));

import { isSignupEnabled } from '../signup-enabled';
import { signupAction, type SignupInput } from '@/app/signup/actions';

const input: SignupInput = {
  orgName: 'Test Flying Club',
  ownerFullName: 'Test Owner',
  email: 'owner@example.com',
  password: 'a-long-password',
  acceptedTerms: true,
};

describe('isSignupEnabled', () => {
  it("is true only for the exact string 'true'", () => {
    expect(isSignupEnabled({ ALLOW_SIGNUP: 'true' })).toBe(true);
  });

  it.each([undefined, '', 'false', '1', 'TRUE', 'True', 'yes', 'on', ' true'])(
    'is false for ALLOW_SIGNUP=%j',
    (value) => {
      expect(isSignupEnabled(value === undefined ? {} : { ALLOW_SIGNUP: value })).toBe(false);
    },
  );

  it('reads process.env by default', () => {
    vi.stubEnv('ALLOW_SIGNUP', 'true');
    expect(isSignupEnabled()).toBe(true);
    vi.stubEnv('ALLOW_SIGNUP', '');
    expect(isSignupEnabled()).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe('signupAction gate', () => {
  beforeEach(() => {
    createOrgWithOwner.mockReset();
    headers.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses with signup_disabled when ALLOW_SIGNUP is unset, touching nothing', async () => {
    vi.stubEnv('ALLOW_SIGNUP', '');
    const result = await signupAction(input);
    expect(result).toEqual({ ok: false, reason: 'signup_disabled' });
    expect(createOrgWithOwner).not.toHaveBeenCalled();
    expect(headers).not.toHaveBeenCalled();
  });

  it('delegates to createOrgWithOwner when ALLOW_SIGNUP=true', async () => {
    vi.stubEnv('ALLOW_SIGNUP', 'true');
    headers.mockResolvedValue(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }));
    createOrgWithOwner.mockResolvedValue({ ok: true, slug: 'test-flying-club', email: input.email });

    const result = await signupAction(input);

    expect(result).toEqual({ ok: true, slug: 'test-flying-club', email: input.email });
    expect(createOrgWithOwner).toHaveBeenCalledWith(input, '203.0.113.7');
  });
});
