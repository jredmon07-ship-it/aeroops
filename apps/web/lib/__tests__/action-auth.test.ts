/**
 * action-auth.test.ts — a server action with a session the server has ended
 * sends the visitor to sign in (lib/action-auth.ts, lib/session-ended.ts).
 *
 * COVERAGE:
 *   1. signInPathFromReferer: an org page → /o/<slug>/login?notice=session-ended;
 *      no Referer, not a URL, not an org page, or a slug that is not one plain
 *      path segment → '/'.
 *   2. actionAuth: a null session redirects to that path, built from the
 *      request's Referer; a live session comes back and nothing redirects.
 *   3. Every 'use server' module under app/o/[slug]/(shell) takes auth() from
 *      lib/action-auth.ts, never straight from '@/auth' — so no action answers
 *      an ended session with { error: 'unauthenticated' } (shown as "You do
 *      not have permission…") instead of the sign-in page.
 *   4. Every (shell) page that calls auth() redirects to /o/<slug>/login, and
 *      none treats a null session as "lacks the capability" (the role-denied
 *      panel Activity, Reports and Help showed after a sidebar click — the
 *      (shell) layout's own redirect does not re-run on client navigation).
 *
 * '@/auth' (next-auth), next/headers and next/navigation are mocked: next-auth
 * cannot load under vitest, and redirect() only means something inside Next.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const { authMock, headersMock, redirectMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  headersMock: vi.fn(),
  // Like Next's redirect(): never returns.
  redirectMock: vi.fn((path: string): never => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { path });
  }),
}));
vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import { actionAuth } from '../action-auth';
import { signInPathFromReferer, SESSION_ENDED_NOTICE } from '../session-ended';

beforeEach(() => {
  authMock.mockReset();
  headersMock.mockReset();
  redirectMock.mockClear();
});

// ═════════════════════════════════════════════════════════════════════════════

describe('1. signInPathFromReferer', () => {
  it('an org page → that org\'s sign-in page with the session-ended notice', () => {
    expect(SESSION_ENDED_NOTICE).toBe('session-ended');
    expect(signInPathFromReferer('https://aeroops.example/o/alpha/schedule/new')).toBe(
      '/o/alpha/login?notice=session-ended',
    );
    expect(signInPathFromReferer('http://localhost:3000/o/bravo-2')).toBe('/o/bravo-2/login?notice=session-ended');
    expect(signInPathFromReferer('http://localhost:3000/o/alpha/?view=month#x')).toBe(
      '/o/alpha/login?notice=session-ended',
    );
  });

  it('anything else → /', () => {
    for (const referer of [
      null,
      undefined,
      '',
      'not a url',
      '/o/alpha/schedule', // relative — not what a browser sends
      'https://aeroops.example/',
      'https://aeroops.example/signup',
      'https://aeroops.example/o/',
      'https://aeroops.example/o//schedule',
      'https://aeroops.example/o/al%2Fpha/schedule', // encoded '/'
      'https://aeroops.example/o/%2F%2Fevil.example/schedule',
      'https://aeroops.example/x/o/alpha',
    ]) {
      expect(signInPathFromReferer(referer), String(referer)).toBe('/');
    }
  });

  it('always a path on this site', () => {
    for (const referer of [
      'https://evil.example/o/alpha',
      'javascript:alert(1)//o/alpha',
      'https://aeroops.example/o/alpha?next=https://evil.example',
    ]) {
      const path = signInPathFromReferer(referer);
      expect(path.startsWith('/'), referer).toBe(true);
      expect(path.startsWith('//'), referer).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('2. actionAuth', () => {
  it('a null session redirects to the org sign-in page named by the Referer', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(new Headers({ referer: 'https://aeroops.example/o/alpha/schedule/board' }));

    await expect(actionAuth()).rejects.toMatchObject({
      message: 'NEXT_REDIRECT',
      path: '/o/alpha/login?notice=session-ended',
    });
    expect(redirectMock).toHaveBeenCalledTimes(1);
  });

  it('a null session with no Referer redirects to /', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(new Headers());

    await expect(actionAuth()).rejects.toMatchObject({ path: '/' });
  });

  it('a live session is returned and nothing redirects', async () => {
    const session = {
      userId: 'u',
      orgId: 'o',
      slug: 'alpha',
      role: 'dispatcher',
      user: { email: 'd@alpha.example' },
      expires: '2099-01-01T00:00:00.000Z',
    };
    authMock.mockResolvedValue(session);

    await expect(actionAuth()).resolves.toBe(session);
    expect(redirectMock).not.toHaveBeenCalled();
    expect(headersMock).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shellDir = join(webRoot, 'app', 'o', '[slug]', '(shell)');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

describe("3. every (shell) server action uses actionAuth", () => {
  const actionModules = walk(shellDir).filter((f) => /^\s*'use server';/m.test(readFileSync(f, 'utf8')));

  it('finds the action modules', () => {
    expect(actionModules.length).toBeGreaterThanOrEqual(20);
  });

  it("none takes auth() straight from '@/auth'; every one that calls auth() imports actionAuth as auth", () => {
    for (const f of actionModules) {
      const src = readFileSync(f, 'utf8');
      const name = relative(webRoot, f);
      expect(src, name).not.toMatch(/from '@\/auth'/);
      if (/\bauth\(\)/.test(src.replace(/^\s*\*.*$/gm, ''))) {
        expect(src, name).toMatch(/^import \{ actionAuth as auth \} from '@\/lib\/action-auth';$/m);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('4. every (shell) page sends a null session to sign-in', () => {
  const pages = walk(shellDir).filter(
    (f) => /[/\\]page\.tsx$/.test(f) && /await auth\(\)/.test(readFileSync(f, 'utf8')),
  );

  it('finds the pages', () => {
    expect(pages.length).toBeGreaterThanOrEqual(30);
  });

  it('each redirects to /o/<slug>/login and none renders a null session as role-denied', () => {
    for (const f of pages) {
      const src = readFileSync(f, 'utf8');
      const name = relative(webRoot, f);
      expect(src, name).toContain('redirect(`/o/${slug}/login`)');
      expect(src, name).not.toMatch(/session \? (hasCapability|can)\(/);
    }
  });
});
