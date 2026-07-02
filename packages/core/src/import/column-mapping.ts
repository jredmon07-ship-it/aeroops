/**
 * import/column-mapping.ts — guessColumnMapping (Slice P1.7).
 *
 * PURE header→field heuristic. previewImport pre-fills the operator's
 * column-mapping step with this guess; the operator confirms/remaps before
 * anything is normalized/staged for real. Never assumes Flight Circle's
 * exact column headers are stable — every provider's export wording differs
 * (e.g. "E-mail" vs "Email Address" vs "Primary Email"), so this is a best-
 * effort heuristic, never authoritative.
 */

export type ImportKind = 'members' | 'aircraft';

/** field name -> CSV header name it was matched to, or null if unmapped. */
export type ColumnMapping = Record<string, string | null>;

/** The importable fields per kind, in PRIORITY order (checked first → wins). */
export const MEMBER_FIELDS = ['email', 'fullName', 'phone'] as const;
export const AIRCRAFT_FIELDS = ['tailNumber', 'make', 'model', 'year', 'serialNumber'] as const;

const MEMBER_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['email', /e-?mail/i],
  ['fullName', /\bname\b/i],
  ['phone', /phone|cell|mobile/i],
];

const AIRCRAFT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['tailNumber', /tail|n-?number|registration/i],
  ['make', /\bmake\b|manufacturer/i],
  ['model', /\bmodel\b/i],
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
