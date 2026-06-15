/**
 * MEMBERSHIP_ROLES — single source of truth for the membership_role enum.
 * Both @aeroops/db (pgEnum) and the application layer import from here to
 * prevent schema/runtime drift.
 *
 * Order matters: Postgres enum types preserve insertion order and some
 * tooling displays them in this order. Do NOT reorder without a migration.
 */
export const MEMBERSHIP_ROLES = [
  'owner',
  'manager',
  'dispatcher',
  'cfi',
  'mechanic',
  'renter',
  'student',
  'accountant',
] as const;

/** Union type of all valid membership role strings. */
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/**
 * isMembershipRole — runtime type guard for MembershipRole.
 *
 * Returns true only when `value` is a string that is an exact member of
 * MEMBERSHIP_ROLES. Returns false for:
 *   - non-string values (null, undefined, numbers, objects)
 *   - unknown/future role strings
 *   - prototype-chain keys ('constructor', 'toString', '__proto__', etc.)
 *
 * Use this at session boundaries (JWT → session projection) to reject
 * injected, malformed, or SSO-supplied role values before they reach the
 * capability-check layer.
 *
 * @param value - Any unknown value from an untrusted source.
 * @returns `true` if value is a valid MembershipRole, `false` otherwise.
 */
export function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === 'string' && (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

/**
 * Human-readable labels for each role, used in UI and reporting.
 * Kept close to the enum so they evolve together.
 */
export const ROLE_LABELS: Record<MembershipRole, string> = {
  owner: 'Owner',
  manager: 'Manager',
  dispatcher: 'Dispatcher',
  cfi: 'CFI',
  mechanic: 'Mechanic',
  renter: 'Renter',
  student: 'Student',
  accountant: 'Accountant',
};
