/**
 * signup.ts — pure helpers for self-serve org signup (slug derivation, reserved
 * slugs, legal-document version). No DB, no I/O — unit-testable.
 *
 * The slug is the tenant's URL key (/o/<slug>/...), so it must be lowercase,
 * URL-safe, collision-checked (by the caller, against the DB), and never one of
 * the app's own top-level route names.
 */

/**
 * The current version string stamped onto a terms/privacy acceptance record.
 * Bump this whenever the published Terms or Privacy Policy change materially, so
 * you can tell who accepted which version. Format: YYYY-MM-DD[-qualifier].
 */
export const LEGAL_DOCUMENT_VERSION = '2026-07-14-draft';

/**
 * Slugs an operator can NEVER take, because they collide with the app's own
 * top-level routes or are otherwise reserved for the platform. Checked AFTER
 * sanitization (all lowercase).
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'book',
  'o',
  'login',
  'logout',
  'signup',
  'signin',
  'sign-up',
  'sign-in',
  'register',
  'admin',
  'settings',
  'demo',
  'alpha',
  'bravo',
  'www',
  'app',
  'health',
  'status',
  'static',
  'assets',
  'public',
  'favicon',
  'robots',
  'sitemap',
]);

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 40;

/**
 * deriveSlugBase — turn an org display name into a candidate slug base, or null
 * if the name has no usable slug (e.g. all punctuation, or a reserved word, or
 * too short after sanitization). The caller appends a numeric suffix on DB
 * collision (deriveSlugCandidate).
 *
 *   "Bravo Flying Club!" → "bravo-flying-club"
 *   "  A & B  "            → "a-b"
 *   "!!!"                  → null
 *   "API"                 → null (reserved)
 */
export function deriveSlugBase(orgName: string): string | null {
  const base = orgName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-') // any run of non-alphanumerics → single hyphen
    .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, ''); // re-trim if the slice landed on a hyphen

  if (base.length < SLUG_MIN_LENGTH) return null;
  if (RESERVED_SLUGS.has(base)) return null;
  return base;
}

/**
 * deriveSlugCandidate — the Nth slug candidate for a base: attempt 0 is the base
 * itself, attempt 1 is "base-2", attempt 2 is "base-3", … Suffixes are trimmed
 * to respect SLUG_MAX_LENGTH. A candidate that collides with a reserved word
 * after suffixing returns null (skip it). The caller tries increasing attempts
 * until an unused, non-reserved candidate is found.
 */
export function deriveSlugCandidate(base: string, attempt: number): string | null {
  if (attempt === 0) {
    return RESERVED_SLUGS.has(base) ? null : base;
  }
  const suffix = `-${attempt + 1}`;
  const trimmedBase = base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/g, '');
  if (trimmedBase.length < 1) return null;
  const candidate = `${trimmedBase}${suffix}`;
  return RESERVED_SLUGS.has(candidate) ? null : candidate;
}

/** Is this string a well-formed, non-reserved slug (post-derivation validation)? */
export function isValidSlug(slug: string): boolean {
  if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH) return false;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return false;
  return !RESERVED_SLUGS.has(slug);
}
