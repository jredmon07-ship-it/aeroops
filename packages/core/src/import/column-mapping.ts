/**
 * import/column-mapping.ts — guessColumnMapping (Slice P1.7).
 *
 * PURE header→field heuristic. previewImport pre-fills the operator's
 * column-mapping step with this guess; the operator confirms/remaps before
 * anything is normalized/staged for real. Never assumes any provider's exact
 * column headers are stable — Flight Circle, myFBO, and every other tool word
 * their exports differently (e.g. "E-mail" vs "Email Address" vs "Primary
 * Email"; "Tail #" vs "N-Number" vs "Registration"), so this is a best-effort
 * heuristic, never authoritative. The operator ALWAYS reviews the mapping
 * before any row is staged, so a slightly greedy guess is safe — it only
 * saves clicks, it never decides anything.
 */

export type ImportKind = 'members' | 'aircraft';

/**
 * ImportSource — which tool the operator is migrating FROM. Purely a label
 * for guidance copy + import-history attribution; it does NOT change the
 * parse/normalize/write path (the column-mapping step handles per-tool header
 * differences generically). 'other' covers any CSV from a tool we don't name.
 */
export type ImportSource = 'flight_circle' | 'myfbo' | 'other';

/** field name -> CSV header name it was matched to, or null if unmapped. */
export type ColumnMapping = Record<string, string | null>;

/** The importable fields per kind, in PRIORITY order (checked first → wins). */
export const MEMBER_FIELDS = ['email', 'fullName', 'phone'] as const;
export const AIRCRAFT_FIELDS = ['tailNumber', 'make', 'model', 'year', 'serialNumber'] as const;

// Patterns are intentionally broad enough to catch Flight Circle AND myFBO
// (and generic-CSV) header wording. Word boundaries keep them from over-
// reaching: `\bmail\b` matches "Mail"/"E-mail"/"Email" but NOT "Mailing
// Address"; `aircraft\s*type` matches an aircraft's model column but NOT a
// ledger's "Transaction Type".
const MEMBER_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['email', /e-?mail|\bmail\b/i],
  ['fullName', /name/i],
  ['phone', /phone|cell|mobile|\btel\b/i],
];

const AIRCRAFT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['tailNumber', /tail|n-?number|registration|\breg\b|aircraft\s*id/i],
  ['make', /\bmake\b|manufacturer/i],
  ['model', /\bmodel\b|aircraft\s*type/i],
  ['year', /\byear\b/i],
  ['serialNumber', /serial/i],
];

/**
 * guessColumnMapping — best-effort header→field heuristic. Each header is
 * claimed by at most one field (first-match-wins, in field priority order),
 * so "Email" never double-maps to both `email` and some other pattern.
 *
 * PURE, never throws — malformed/garbage headers (empty strings, duplicates,
 * non-ASCII) simply fail to match and the field stays null.
 */
export function guessColumnMapping(
  headers: readonly string[],
  kind: ImportKind,
): ColumnMapping {
  const patterns = kind === 'aircraft' ? AIRCRAFT_PATTERNS : MEMBER_PATTERNS;
  const safeHeaders = Array.isArray(headers) ? headers.filter((h) => typeof h === 'string') : [];
  const used = new Set<string>();
  const mapping: ColumnMapping = {};

  for (const [field, pattern] of patterns) {
    let matched: string | null = null;
    for (const header of safeHeaders) {
      if (used.has(header)) continue;
      try {
        if (pattern.test(header)) {
          matched = header;
          break;
        }
      } catch {
        // Defensive — RegExp#test on a string never throws, but keep the
        // "never throws" contract airtight against any future pattern change.
        continue;
      }
    }
    mapping[field] = matched;
    if (matched) used.add(matched);
  }

  return mapping;
}

/**
 * looksLikeSalesTransactionsExport — heuristic detector for a Flight-Circle-
 * style ledger/financial-history export (their "Sales Transactions"
 * download), regardless of which `kind` the operator selected. Two or more
 * money/ledger-shaped header hints → true. Used by previewImport to mark a
 * batch out-of-scope-for-commit (see docs/specs/slice-p1-fc-import.md).
 *
 * PURE, never throws.
 */
export function looksLikeSalesTransactionsExport(headers: readonly string[]): boolean {
  const hints = ['amount', 'transaction', 'payment', 'charge', 'balance', 'invoice', 'debit', 'credit'];
  const safeHeaders = Array.isArray(headers) ? headers.filter((h) => typeof h === 'string') : [];
  let matches = 0;
  for (const header of safeHeaders) {
    const lower = header.toLowerCase();
    if (hints.some((hint) => lower.includes(hint))) matches++;
  }
  return matches >= 2;
}
