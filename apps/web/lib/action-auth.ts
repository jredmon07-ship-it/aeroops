/**
 * lib/action-auth.ts — auth() for server actions: a session the server has
 * ended sends the visitor to sign in.
 *
 * WHY: the middleware only checks the session cookie's signature, so a server
 * action posted with a session the server has since ended (a password reset,
 * a removed membership, a suspended org — see
 * packages/api/src/auth/session-revalidation.ts) still runs, and its auth()
 * returns null. Every @aeroops/api call then throws UnauthenticatedError,
 * which the actions return as { error: 'unauthenticated' } — and most
 * screens show that as "You do not have permission…", with the header still
 * showing the member as signed in. Pages already redirect a null session to
 * /o/<slug>/login; actionAuth() does the same for server actions.
 *
 * HOW: actionAuth() is auth(), except that a null session redirect()s to the
 * org's sign-in page (lib/session-ended.ts — with a "session ended" notice).
 * redirect() in a server action makes the client router navigate there.
 * Every action calls it first, before its try/catch, so no catch-all can
 * swallow the redirect. A database error during the session check lands
 * here too: the same fail-closed answer a page load gives.
 *
 * USAGE (every 'use server' module under app/o/[slug]/(shell)):
 *   import { actionAuth as auth } from '@/lib/action-auth';
 *   …
 *   const session = await auth();
 *
 * Server-only (next/headers). Pages keep using '@/auth' — they redirect on
 * their own.
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Session } from 'next-auth';
import { auth } from '@/auth';
import { signInPathFromReferer } from './session-ended';

export async function actionAuth(): Promise<Session> {
  const session = await auth();
  if (!session) {
    redirect(signInPathFromReferer((await headers()).get('referer')));
  }
  return session;
}
