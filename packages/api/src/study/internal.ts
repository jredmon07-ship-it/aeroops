/**
 * internal.ts — pure helpers for the AeroStudy integration (Slice STUDY-1).
 *
 * Everything here is PURE (no db, no I/O, no Date.now()) so it can be
 * unit-tested exhaustively:
 *   - scope → EntitlementState mapping (mapScopesToEntitlements)
 *   - untrusted-body validation for the progress upsert
 *     (parseStudyProgressInput)
 *   - the client cache-TTL expiry (computeEntitlementsExpiresAt)
 *   - missing-relation detection for the ships-before-migration posture
 *     (isMissingRelationError) + StudyTablesNotMigratedError
 *
 * SCOPE / CERT-CODE FORMAT: a grant scope is either the literal
 * 'all_access' or an FAA knowledge-test cert code — uppercase alphanumeric,
 * 2–10 chars, starting with a letter (e.g. 'PAR', 'IRA'). This MUST match
 * study_grant_scope_format_check / study_progress_cert_code_format_check in
 * migration 0035. Client-side, codes map 1:1 onto AeroStudy product IDs
 * (aerostudy.cert.<code> / aerostudy.allaccess.*) — the map lives in the
 * iOS app, never here.
 */

import type { StudyEntitlementState, StudyProgressInput } from './types.js';

// ─── Scope format ─────────────────────────────────────────────────────────────

/** The grant scope meaning "every question bank" (design doc §4). */
export const STUDY_SCOPE_ALL_ACCESS = 'all_access' as const;

/**
 * Cert-code pattern — MUST stay in sync with the CHECK constraints in
 * migration 0035_study_grant.sql (study_grant_scope_format_check /
 * study_progress_cert_code_format_check).
 */
export const STUDY_CERT_CODE_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

/** True when `value` is a well-formed cert code (e.g. 'PAR'). */
export function isValidCertCode(value: string): boolean {
  return STUDY_CERT_CODE_PATTERN.test(value);
}

// ─── Scope → entitlement mapping ──────────────────────────────────────────────

/**
 * mapScopesToEntitlements — folds the caller's UNREVOKED grant scopes into
 * the AeroStudy EntitlementState shape (design doc §2a):
 *
 *   { hasAllAccess: bool, unlockedCertCodes: string[] }
 *
 * PURE + defensive:
 *   - 'all_access' (any number of times) → hasAllAccess: true.
 *   - Well-formed cert codes are deduplicated and sorted (deterministic
 *     wire output).
 *   - Anything else (malformed row that somehow bypassed the DB CHECK) is
 *     SILENTLY DROPPED — a grant can only ever ADD access, so dropping an
 *     unrecognizable scope fails closed.
 *   - hasAllAccess does NOT clear unlockedCertCodes: the client merges
 *     sets; sending both is harmless and keeps this a pure fold.
 */
export function mapScopesToEntitlements(scopes: readonly string[]): StudyEntitlementState {
  let hasAllAccess = false;
  const codes = new Set<string>();

  for (const scope of scopes) {
    if (scope === STUDY_SCOPE_ALL_ACCESS) {
      hasAllAccess = true;
    } else if (isValidCertCode(scope)) {
      codes.add(scope);
    }
    // else: malformed → dropped (fail-closed; can only under-grant).
  }

  return {
    hasAllAccess,
    unlockedCertCodes: [...codes].sort(),
  };
}

// ─── Entitlements cache TTL ───────────────────────────────────────────────────

/** Client cache TTL for a fetched entitlement set: 7 days (design doc §3). */
export const ENTITLEMENTS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * computeEntitlementsExpiresAt — `now` + 7 days, as an ISO-8601 string.
 * The on-device grant cache stops unlocking after this instant, so a
 * revoked/lapsed school membership expires without the app needing to be
 * online at revocation time.
 */
export function computeEntitlementsExpiresAt(now: Date): string {
  return new Date(now.getTime() + ENTITLEMENTS_TTL_MS).toISOString();
}

// ─── Progress-input validation ────────────────────────────────────────────────

/** Discriminated parse result — no exceptions from the pure layer. */
export type ParseStudyProgressResult =
  | { ok: true; input: StudyProgressInput }
  | { ok: false; error: string };

/**
 * parseStudyProgressInput — validates an UNTRUSTED JSON body for
 * POST /api/mobile/v1/study/progress.
 *
 * Accepts exactly:
 *   {
 *     certCode:         string  — cert code, e.g. 'PAR' (never 'all_access')
 *     readinessPercent: number  — finite, 0 ≤ x ≤ 1 (a FRACTION, not 0–100)
 *     questionsLogged:  number  — non-negative SAFE integer
 *     lastStudiedAt:    string  — parseable ISO-8601 instant
 *   }
 *
 * Every failure names the offending field (specific error copy per the
 * shared standards). lastStudiedAt is normalized to a Date so the data
 * layer never re-parses.
 */
export function parseStudyProgressInput(body: unknown): ParseStudyProgressResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }

  const b = body as Record<string, unknown>;

  const certCode = b['certCode'];
  if (typeof certCode !== 'string' || !isValidCertCode(certCode)) {
    return {
      ok: false,
      error:
        "certCode must be an uppercase alphanumeric cert code (2-10 chars, e.g. 'PAR')",
    };
  }

  const readinessPercent = b['readinessPercent'];
  if (
    typeof readinessPercent !== 'number' ||
    !Number.isFinite(readinessPercent) ||
    readinessPercent < 0 ||
    readinessPercent > 1
  ) {
    return {
      ok: false,
      error: 'readinessPercent must be a number between 0 and 1 (a fraction, not 0-100)',
    };
  }

  const questionsLogged = b['questionsLogged'];
  if (
    typeof questionsLogged !== 'number' ||
    !Number.isSafeInteger(questionsLogged) ||
    questionsLogged < 0
  ) {
    return { ok: false, error: 'questionsLogged must be a non-negative integer' };
  }

  const lastStudiedAt = b['lastStudiedAt'];
  if (typeof lastStudiedAt !== 'string') {
    return { ok: false, error: 'lastStudiedAt must be an ISO-8601 timestamp string' };
  }
  const lastStudiedAtDate = new Date(lastStudiedAt);
  if (Number.isNaN(lastStudiedAtDate.getTime())) {
    return { ok: false, error: 'lastStudiedAt must be a parseable ISO-8601 timestamp' };
  }

  return {
    ok: true,
    input: {
      certCode,
      readinessPercent,
      questionsLogged,
      lastStudiedAt: lastStudiedAtDate,
    },
  };
}

// ─── Ships-before-migration posture ───────────────────────────────────────────

/**
 * StudyTablesNotMigratedError — thrown by the study data-access functions
 * when study_grant / study_progress do not exist yet.
 *
 * Migration 0035 is STAGED + HUMAN-GATED (repo convention: migrations are
 * never auto-run), so this code path WILL be live before the tables exist.
 * The repo has no prior code-ships-before-migration runtime pattern
 * (earlier slices merely staged code + migration together and relied on the
 * human applying both before exposure), so this error is the explicit seam:
 * the mobile routes map it to a clean HTTP 503
 * { error: 'study_tables_not_migrated' } instead of a generic 500.
 */
export class StudyTablesNotMigratedError extends Error {
  readonly code = 'STUDY_TABLES_NOT_MIGRATED' as const;

  constructor() {
    super(
      '[study] study_grant / study_progress tables are missing — ' +
        'migration 0035_study_grant.sql has not been applied yet (human-gated).',
    );
    this.name = 'StudyTablesNotMigratedError';
  }
}

/**
 * isMissingRelationError — true when `err` (or anything in its `cause`
 * chain, bounded) is Postgres error 42P01 undefined_table.
 *
 * Both drivers surface the SQLSTATE: postgres-js sets `code` on the thrown
 * error; PGlite (tests) sets `code` on the cause it wraps. The message
 * fallback covers driver wrappers that drop the code but keep the standard
 * `relation "…" does not exist` text.
 */
export function isMissingRelationError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as Error & { code?: unknown }).code;
    if (code === '42P01') return true;
    if (/relation "[^"]*" does not exist/.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}
