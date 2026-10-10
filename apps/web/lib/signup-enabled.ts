/**
 * lib/signup-enabled.ts — the self-serve signup switch.
 *
 * Self-serve org signup (/signup → signupAction → createOrgWithOwner) is OFF
 * unless the deployment explicitly sets ALLOW_SIGNUP=true. Default OFF keeps
 * the public demo deployment from being used by strangers to create real
 * operations; self-hosters turn it on to create their first operation.
 *
 * SERVER-ONLY: reads process.env at request time. Call it from server
 * components and server actions, never from client components. The check in
 * signupAction is the real enforcement; hiding the form and links is courtesy.
 */

/**
 * isSignupEnabled — true ONLY when ALLOW_SIGNUP is exactly the string 'true'.
 * Unset, empty, '1', 'TRUE', 'yes', etc. all count as OFF (fail-closed).
 */
export function isSignupEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.ALLOW_SIGNUP === 'true';
}
