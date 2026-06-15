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
