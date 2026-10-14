/**
 * demo-login.test.ts — the signup page's "only link to a demo org that exists" helper.
 *
 * No DOM, no Next.js runtime, no DB (the resolver is injected).
 */
import { describe, expect, it, vi } from 'vitest';
import { findActiveOrgLoginHref, loginHrefForActiveOrg } from '../demo-login';

describe('loginHrefForActiveOrg', () => {
  it('returns the sign-in href for an active org', () => {
    expect(loginHrefForActiveOrg({ slug: 'bravo', status: 'active' })).toBe('/o/bravo/login');
  });

  it('returns null for an unknown org', () => {
    expect(loginHrefForActiveOrg(null)).toBeNull();
  });

  it('returns null for a suspended org (indistinguishable from unknown)', () => {
    expect(loginHrefForActiveOrg({ slug: 'bravo', status: 'suspended' })).toBeNull();
  });
});

describe('findActiveOrgLoginHref', () => {
  it('resolves the given slug and links only when active', async () => {
    const resolve = vi.fn().mockResolvedValue({ slug: 'bravo', status: 'active' });
    await expect(findActiveOrgLoginHref('bravo', resolve)).resolves.toBe('/o/bravo/login');
    expect(resolve).toHaveBeenCalledWith('bravo');
  });

  it('returns null when the org does not exist on this server', async () => {
    await expect(findActiveOrgLoginHref('bravo', async () => null)).resolves.toBeNull();
  });

  it('returns null (does not throw) when the resolver fails', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('db down'));
    await expect(findActiveOrgLoginHref('bravo', resolve)).resolves.toBeNull();
  });
});
