/**
 * actions.ts — Server actions for the /o/[slug] route group.
 *
 * Sign-out is the only action in this slice. It calls NextAuth's signOut
 * which clears the JWT cookie and redirects to the org's login page.
 *
 * The redirect target is /o/[slug]/login — always back to the same org's
 * login so the user knows where they logged out from.
 */
'use server';

import { signOut } from '@/auth';

/**
 * signOutAction — signs the current user out and redirects to login.
 *
 * @param slug - The org URL slug; used to build the post-logout redirect URL.
 */
export async function signOutAction(slug: string): Promise<void> {
  await signOut({ redirectTo: `/o/${slug}/login` });
}
