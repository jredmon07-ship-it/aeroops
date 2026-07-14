/**
 * signup/actions.ts — the server action behind the self-serve signup form.
 *
 * Thin boundary: read the client IP (for the acceptance record), call
 * @aeroops/api createOrgWithOwner, map errors to a typed result. Imports ONLY
 * @aeroops/api — never @aeroops/db. The org is created server-side; the org_id
 * is never trusted from the client.
 */
'use server';

import { headers } from 'next/headers';
import { createOrgWithOwner } from '@aeroops/api';
import { isValidationError } from '@/lib/action-errors-result';

export interface SignupInput {
  orgName: string;
  ownerFullName: string;
  email: string;
  password: string;
  acceptedTerms: boolean;
  website?: string; // honeypot
}

export type SignupActionResult =
  | { ok: true; slug: string; email: string }
  | { ok: false; reason: 'invalid_name' }
  | { ok: false; reason: 'slug_unavailable' }
  | { error: 'validation'; message: string }
  | { error: 'server' };

export async function signupAction(input: SignupInput): Promise<SignupActionResult> {
  // Coarse client IP for the acceptance record (first hop of x-forwarded-for).
  let acceptedIp: string | null = null;
  try {
    const h = await headers();
    acceptedIp = (h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || null) ?? null;
  } catch {
    acceptedIp = null;
  }

  try {
    return await createOrgWithOwner(input, acceptedIp);
  } catch (err) {
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}
