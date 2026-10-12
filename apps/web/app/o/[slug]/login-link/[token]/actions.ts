/**
 * login-link/[token]/actions.ts — the server action behind the set-password
 * form on a login link.
 *
 * UNAUTHENTICATED by design: the signed link token IS the credential.
 * acceptLoginLink (@aeroops/api) verifies the token, checks the URL slug is
 * the token's org, re-checks the member is still active and the link is
 * unused, applies the signup password policy, and sets the password in one
 * transaction. Every "this link can't be used" case comes back as the single
 * reason 'invalid_link'. The token and password are never logged.
 *
 * BOUNDARY: imports ONLY @aeroops/api — never @aeroops/db.
 */
'use server';

import { acceptLoginLink } from '@aeroops/api';
import { isValidationError } from '@/lib/action-errors-result';

export type AcceptLoginLinkActionResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_link' }
  | { error: 'validation'; message: string }
  | { error: 'server' };

export async function acceptLoginLinkAction(input: {
  slug: string;
  token: string;
  password: string;
}): Promise<AcceptLoginLinkActionResult> {
  try {
    const result = await acceptLoginLink(input);
    if (!result.ok) return { ok: false, reason: 'invalid_link' };
    return { ok: true };
  } catch (err) {
    if (isValidationError(err)) {
      // "[login-link] Use at least 10 characters" → the human part only.
      return { error: 'validation', message: err.message.replace(/^\[[^\]]+\]\s*/, '') };
    }
    return { error: 'server' };
  }
}
