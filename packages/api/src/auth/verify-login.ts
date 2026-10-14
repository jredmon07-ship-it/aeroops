/**
 * verify-login.ts — Shared login orchestration pipeline.
 *
 * Extracted from auth-config.ts's Credentials `authorize` callback so that
 * BOTH the web NextAuth flow AND the mobile login route call the IDENTICAL
 * pipeline — never a forked reimplementation.
 *
 * PIPELINE (byte-identical to the original authorize steps 1–6):
 *   1. Parse input with the SAME loginSchema (zod, from auth-config.ts).
 *   2. resolveOrgBySlug — platform-admin read; returns null if slug unknown.
 *   3. status === 'active' gate — rejects suspended/inactive orgs.
 *   4. verifyCredential — tenant-scoped argon2 verify + anti-enumeration.
 *   5. Return { userId, orgId, slug, role, email, cfp } on success; null on ANY
 *      failure. No distinction between failure steps (anti-enumeration: single
 *      generic null).
 *
 * SECURITY INVARIANTS:
 *   - Returns null on ALL auth failures; only throws on infrastructure errors.
 *   - orgId is NEVER read from the caller's input — it comes from resolveOrgBySlug
 *     (DB lookup keyed on slug). The signed token is the only trusted orgId carrier.
 *   - Never reveals which step failed.
 *
 * TWO CALLING FORMS:
 *   1. verifyLoginAndIssueClaims(db, input) — uses the caller-supplied db.
 *      Used by auth-config.ts's authorize (which passes getDb() result).
 *   2. verifyLoginAndIssueClaimsWithDb(db, input) — alias for tests (pglite injection).
 *      Tests MUST use this form to avoid triggering getDb().
 */
import type { AnyDb } from '@aeroops/db';
import type { z } from 'zod';
import { loginSchema } from './auth-config.js';
import { resolveOrgBySlug } from './resolve-org.js';
import { verifyCredential } from './verify-credential.js';

// ─── Claim shape ─────────────────────────────────────────────────────────────

/**
 * MobileClaims — the identity claims every session form shares: the mobile
 * access token carries exactly these, the web session these plus `cfp`
 * (LoginClaims below).
 *   { userId, orgId, slug, role, email }
 *
 * orgId is derived server-side from the slug lookup — NEVER from caller input.
 */
export interface MobileClaims {
  userId: string;
  orgId: string;
  slug: string;
  role: string;
  email: string;
}

/**
 * LoginClaims — what a successful password login returns: MobileClaims plus
 * `cfp`, the session credential fingerprint of the credential that just
 * verified (session-revalidation.ts). The web session embeds it so a later
 * password change ends that session. The mobile token never carries it
 * (signMobileToken copies the MobileClaims fields only; mobile revocation runs
 * through mobile_session), and no route returns it to a client.
 */
export interface LoginClaims extends MobileClaims {
  cfp: string;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * _verifyLoginAndIssueClaimsImpl — shared login pipeline implementation.
 *
 * @param db    - Drizzle client (prod or pglite test client).
 * @param input - Raw { slug, email, password } (already zod-parsed by callers
 *                that pass raw credentials, or raw input parsed here).
 * @returns LoginClaims on success; null on ANY auth failure.
 * @throws  On infrastructure errors (DB unreachable, etc.) — let these propagate.
 */
async function _verifyLoginAndIssueClaimsImpl(
  db: AnyDb,
  input: z.infer<typeof loginSchema>,
): Promise<LoginClaims | null> {
  const { slug, email, password } = input;

  // Step 1: Resolve org by slug.
  const resolvedOrg = await resolveOrgBySlug(db, slug);
  if (!resolvedOrg) {
    return null;
  }

  // Step 2: Reject suspended or inactive orgs.
  if (resolvedOrg.status !== 'active') {
    return null;
  }

  // Step 3: Verify credential (tenant-scoped, anti-enumeration, RLS).
  const verified = await verifyCredential(db, resolvedOrg.id, email, password);
  if (!verified) {
    return null;
  }

  // Step 4: Return the claim object.
  // orgId comes from the DB-resolved org, never from the caller's input.
  return {
    userId: verified.userId,
    orgId: resolvedOrg.id,
    slug: resolvedOrg.slug,
    role: verified.role,
    email: verified.email,
    cfp: verified.cfp,
  };
}

/**
 * verifyLoginAndIssueClaims — shared login pipeline.
 *
 * Accepts a pre-parsed input (z.infer<typeof loginSchema>) so callers that
 * already validated the input (like auth-config.ts's authorize) don't re-parse.
 * The mobile login route SHOULD parse with loginSchema first (parse → then call
 * this with the parsed result).
 *
 * @param db    - Drizzle client (from getDb() in production).
 * @param input - Pre-validated { slug, email, password }.
 * @returns LoginClaims on success; null on ANY failure.
 */
export async function verifyLoginAndIssueClaims(
  db: AnyDb,
  input: z.infer<typeof loginSchema>,
): Promise<LoginClaims | null> {
  return _verifyLoginAndIssueClaimsImpl(db, input);
}

/**
 * verifyLoginAndIssueClaimsWithDb — test-injectable form.
 *
 * Identical contract to verifyLoginAndIssueClaims; the name suffix signals to
 * test authors that this is the pglite-injection point (mirrors the *WithDb
 * convention used throughout the codebase).
 *
 * Tests MUST use this form so they never trigger getDb() (which requires a
 * real DATABASE_URL and a running Postgres instance).
 *
 * @param db    - Drizzle client (pglite test client).
 * @param input - Pre-validated { slug, email, password }.
 * @returns LoginClaims on success; null on ANY failure.
 */
export async function verifyLoginAndIssueClaimsWithDb(
  db: AnyDb,
  input: z.infer<typeof loginSchema>,
): Promise<LoginClaims | null> {
  return _verifyLoginAndIssueClaimsImpl(db, input);
}
