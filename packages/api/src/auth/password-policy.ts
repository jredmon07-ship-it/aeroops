/**
 * auth/password-policy.ts — the ONE rule for a newly-chosen password.
 *
 * Shared by every path that sets a password: self-serve signup
 * (createOrgWithOwner) and accepting a login link (acceptLoginLink). Keeping
 * it in one place means the two can never drift. Hashing is always
 * hashPassword (argon2id, hash.ts) — this file only decides what is allowed.
 *
 * Login (verifyCredential) deliberately does NOT apply this schema: a
 * password set under an older policy must still be able to sign in.
 */
import { z } from 'zod';

/** Minimum length for a new password (characters). */
export const PASSWORD_MIN_LENGTH = 10;

/** Maximum length — bounds argon2 input and the request body. */
export const PASSWORD_MAX_LENGTH = 200;

/** newPasswordSchema — zod rule for a password a person is choosing now. */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { message: `Use at least ${PASSWORD_MIN_LENGTH} characters` })
  .max(PASSWORD_MAX_LENGTH, { message: 'Password is too long' });
