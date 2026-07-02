/**
 * import/normalize.ts — normalizeMemberRow / normalizeAircraftRow (Slice P1.7).
 *
 * PURE: given a raw parsed-CSV row (Record<string,string>) + a confirmed
 * column mapping, produce a typed, validated candidate ready for the
 * EXISTING addMember / createResource+updateAircraft write paths — or a
 * typed skip reason. NEVER throws, even on wildly malformed/garbage input
 * (a hostile or corrupted CSV must never crash the preview step).
 *
 * dedupeKey is the normalized identity used for duplicate detection against
 * both existing org records and other rows within the same batch:
 *   members  → lowercased, trimmed email
 *   aircraft → uppercased, whitespace-stripped tail number
 *
 * [VERIFY] no FAA/regulatory meaning is attached to any imported field —
 * this is a plain roster/identity import, same posture as addMember /
 * createResource+updateAircraft.
 */
import type { ColumnMapping } from './column-mapping.js';

export type NormalizeResult<T> =
  | { ok: true; value: T; dedupeKey: string }
  | { ok: false; reason: string };

export interface MemberCandidate {
  email: string;
  fullName: string | null;
  phone: string | null;
}

export interface AircraftCandidate {
  tailNumber: string;
  make: string | null;
  model: string | null;
  year: number | null;
  serialNumber: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;
const MAX_TEXT_LEN = 200;
const MAX_TAIL_LEN = 20;

/** Defensive field extraction — never throws regardless of what `row` actually is. */
function safeGet(row: unknown, mapping: ColumnMapping, field: string): string {
  try {
    const header = mapping?.[field];
    if (!header || typeof header !== 'string') return '';
    if (row == null || typeof row !== 'object') return '';
    const v = (row as Record<string, unknown>)[header];
    if (typeof v !== 'string') return '';
    return v.trim();
  } catch {
    return '';
  }
}

/**
 * normalizeMemberRow — validate + shape one raw CSV row into a MemberCandidate.
 * Required: a syntactically valid email (the addMember write path's own
 * uniqueness check is the authoritative dedupe backstop; dedupeKey here is
 * for the PREVIEW-time duplicate flag).
 */
export function normalizeMemberRow(
  row: Record<string, string> | null | undefined,
  mapping: ColumnMapping,
): NormalizeResult<MemberCandidate> {
  try {
    const emailRaw = safeGet(row, mapping, 'email');
    const email = emailRaw.toLowerCase();
    if (!email) return { ok: false, reason: 'missing_email' };
    if (email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) {
      return { ok: false, reason: 'invalid_email' };
    }

    const fullNameRaw = safeGet(row, mapping, 'fullName');
    const fullName = fullNameRaw ? fullNameRaw.slice(0, MAX_TEXT_LEN) : null;

    const phoneRaw = safeGet(row, mapping, 'phone');
    const phone = phoneRaw ? phoneRaw.slice(0, 40) : null;

    return {
      ok: true,
      value: { email, fullName, phone },
      dedupeKey: email,
    };
  } catch {
    return { ok: false, reason: 'malformed_row' };
  }
}

/**
 * normalizeAircraftRow — validate + shape one raw CSV row into an
 * AircraftCandidate. Required: a non-empty tail number. year is parsed
 * best-effort (first 4-digit run in range 1900–2200); an unparsable/absent
 * year is simply null, never a hard skip (matches updateAircraft's own
 * validation posture — year is optional identity metadata).
 */
export function normalizeAircraftRow(
  row: Record<string, string> | null | undefined,
  mapping: ColumnMapping,
): NormalizeResult<AircraftCandidate> {
  try {
    const tailRaw = safeGet(row, mapping, 'tailNumber');
    const tailNumber = tailRaw.toUpperCase().replace(/\s+/g, '').slice(0, MAX_TAIL_LEN);
    if (!tailNumber) return { ok: false, reason: 'missing_tail_number' };

    const make = safeGet(row, mapping, 'make').slice(0, MAX_TEXT_LEN) || null;
    const model = safeGet(row, mapping, 'model').slice(0, MAX_TEXT_LEN) || null;
    const serialNumber = safeGet(row, mapping, 'serialNumber').slice(0, MAX_TEXT_LEN) || null;

    const yearRaw = safeGet(row, mapping, 'year');
    let year: number | null = null;
    if (yearRaw) {
      const digits = yearRaw.match(/\d{4}/);
      if (digits) {
        const y = parseInt(digits[0], 10);
        if (!Number.isNaN(y) && y >= 1900 && y <= 2200) year = y;
      }
    }

    return {
      ok: true,
      value: { tailNumber, make, model, year, serialNumber },
      dedupeKey: tailNumber,
    };
  } catch {
    return { ok: false, reason: 'malformed_row' };
  }
}
