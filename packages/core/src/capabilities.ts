/**
 * capabilities.ts — Role-capability matrix for AeroOps RBAC.
 *
 * This is the single source of truth for what each role can do.
 * It is framework-agnostic and has no I/O — it is safe to import
 * anywhere (web, mobile, api).
 *
 * AUTHZ INVARIANT:
 *   All permission checks MUST go through `can()` or `requireCapability()`
 *   (in @aeroops/api). Raw `role === 'x'` guards are forbidden.
 *
 * EXTENSIBILITY:
 *   New capabilities are added here (e.g. 'schedule:create' in Slice 1).
 *   ROLE_CAPABILITIES must remain exhaustive over MEMBERSHIP_ROLES — the
 *   `satisfies` constraint enforces this at compile time.
 *
 * FAIL-CLOSED CONTRACT:
 *   can() returns false for any unknown role or unknown capability.
 *   It never throws.
 */
import { MEMBERSHIP_ROLES } from './roles.js';
import type { MembershipRole } from './roles.js';

// ─── Capability registry ──────────────────────────────────────────────────────

/**
 * CAPABILITIES — exhaustive list of all defined capabilities.
 *
 * Keep this sorted alphabetically so diffs are minimal when new capabilities
 * are added in later Hub slices.
 *
 * DO NOT add Hub-specific capabilities here until the corresponding Hub
 * slice is approved (schedule:*, billing:*, etc.).
 */
export const CAPABILITIES = [
  'app:access',
  'org:manage_settings',
] as const;

/** Union type of all valid capability strings. */
export type Capability = (typeof CAPABILITIES)[number];

// ─── Role → capability matrix ─────────────────────────────────────────────────

/**
 * ROLE_CAPABILITIES — maps every MembershipRole to the capabilities it grants.
 *
 * The `satisfies Record<MembershipRole, readonly Capability[]>` constraint
 * makes it a compile error to:
 *   (a) add a new role to MEMBERSHIP_ROLES without updating this matrix, or
 *   (b) list a string that is not a valid Capability.
 *
 * Matrix (rows = roles, columns = capabilities):
 *
 *   Role          | app:access | org:manage_settings |
 *   --------------|------------|---------------------|
 *   owner         |     ✓      |         ✓           |
 *   manager       |     ✓      |         ✓           |
 *   dispatcher    |     ✓      |                     |
 *   cfi           |     ✓      |                     |
 *   mechanic      |     ✓      |                     |
 *   renter        |     ✓      |                     |
 *   student       |     ✓      |                     |
 *   accountant    |     ✓      |                     |
 */
export const ROLE_CAPABILITIES = {
  owner:      ['app:access', 'org:manage_settings'] as const,
  manager:    ['app:access', 'org:manage_settings'] as const,
  dispatcher: ['app:access'] as const,
  cfi:        ['app:access'] as const,
  mechanic:   ['app:access'] as const,
  renter:     ['app:access'] as const,
  student:    ['app:access'] as const,
  accountant: ['app:access'] as const,
} satisfies Record<MembershipRole, readonly Capability[]>;

// Compile-time check: every role in MEMBERSHIP_ROLES must appear as a key.
// TypeScript's `satisfies` above handles this — this comment is the rationale.
// Runtime exhaustiveness: the object keys at runtime should equal MEMBERSHIP_ROLES.
// Verified by unit tests.

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * can — pure predicate: does `role` have `capability`?
 *
 * FAIL-CLOSED: unknown role OR unknown capability → false (never throws).
 * This means any typo or future gap defaults to denied.
 *
 * PROTOTYPE-CHAIN SAFETY: role strings that are Object.prototype member names
 * (e.g. 'constructor', 'toString', '__proto__') would resolve up the prototype
 * chain to a truthy non-array, causing `caps.includes` to throw a TypeError.
 * We guard with both an own-property check AND Array.isArray so that any lookup
 * that escapes the own properties of ROLE_CAPABILITIES returns false rather than
 * throwing.
 *
 * @param role       - A MembershipRole (or any string for safety).
 * @param capability - A Capability (or any string for safety).
 * @returns true if the role has the capability, false otherwise.
 */
export function can(
  role: MembershipRole | (string & {}),
  capability: Capability | (string & {}),
): boolean {
  if (!Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, role)) return false;
  const caps = ROLE_CAPABILITIES[role as MembershipRole];
  if (!Array.isArray(caps)) return false;
  return (caps as readonly string[]).includes(capability);
}

/**
 * capabilitiesForRole — returns the capability list for a role.
 *
 * Returns an empty readonly array for unknown roles (fail-closed).
 * Intended for UI nav building (e.g. hiding menu items). NOT a gate.
 *
 * PROTOTYPE-CHAIN SAFETY: same own-property + Array.isArray guard as can().
 * Prototype-key role strings return [] and never throw.
 *
 * @param role - A MembershipRole (or any string for safety).
 * @returns readonly Capability[] (may be empty).
 */
export function capabilitiesForRole(
  role: MembershipRole | (string & {}),
): readonly Capability[] {
  if (!Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, role)) return [];
  const caps = ROLE_CAPABILITIES[role as MembershipRole];
  if (!Array.isArray(caps)) return [];
  return caps;
}

// ─── Compile-time exhaustiveness guard ───────────────────────────────────────
// Ensures that every entry in MEMBERSHIP_ROLES has a key in ROLE_CAPABILITIES.
// If a new role is added to MEMBERSHIP_ROLES without updating ROLE_CAPABILITIES,
// the `satisfies` above will produce a compile error. This comment explains why.
const _exhaustiveCheck: Record<(typeof MEMBERSHIP_ROLES)[number], unknown> =
  ROLE_CAPABILITIES;
void _exhaustiveCheck; // suppress "unused variable" warnings
