/**
 * scheduling/enums.ts — single source of truth for scheduling enum types.
 *
 * Mirrors the MEMBERSHIP_ROLES pattern (see ../roles.ts): both @aeroops/db
 * (pgEnum) and the application layer import these tuples so the Drizzle schema
 * and the runtime can never drift. The schema-engineer builds the pgEnums FROM
 * these `as const` tuples.
 *
 * No I/O, framework-agnostic — safe to import anywhere.
 */

/**
 * RESOURCE_KINDS — canonical list of bookable resource kinds.
 *
 * Order matters: Postgres enum types preserve insertion order and some tooling
 * displays them in this order. Do NOT reorder without a migration.
 *
 * FORWARD-COMPAT: Slice 1 only populates `aircraft` + `instructor`, but the
 * tuple intentionally includes all five so adding sim/room/vehicle is a pure
 * data change, not an enum/migration change (ADR-0004).
 */
export const RESOURCE_KINDS = [
  'aircraft',
  'instructor',
  'sim',
  'room',
  'vehicle',
] as const;

/** Union type of all valid resource-kind strings. */
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * RESERVATION_STATUSES — canonical list of reservation statuses.
 *
 * Order matters (see RESOURCE_KINDS). Slice 1 supports the full set:
 * conflict detection only considers `booked` rows; `cancelled` rows never
 * collide (the EXCLUDE constraint is `WHERE status='booked'`, ADR-0004).
 */
export const RESERVATION_STATUSES = ['booked', 'cancelled'] as const;

/** Union type of all valid reservation-status strings. */
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * isResourceKind — runtime type guard for ResourceKind.
 *
 * Returns true only when `value` is a string that is an exact member of
 * RESOURCE_KINDS. Returns false for non-strings, unknown/future kind strings,
 * and prototype-chain keys ('constructor', 'toString', '__proto__', etc.).
 * Mirrors isMembershipRole; use at untrusted boundaries.
 *
 * @param value - Any unknown value from an untrusted source.
 * @returns `true` if value is a valid ResourceKind, `false` otherwise.
 */
export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && (RESOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * isReservationStatus — runtime type guard for ReservationStatus.
 *
 * Same contract as isResourceKind, over RESERVATION_STATUSES.
 *
 * @param value - Any unknown value from an untrusted source.
 * @returns `true` if value is a valid ReservationStatus, `false` otherwise.
 */
export function isReservationStatus(value: unknown): value is ReservationStatus {
  return (
    typeof value === 'string' && (RESERVATION_STATUSES as readonly string[]).includes(value)
  );
}
