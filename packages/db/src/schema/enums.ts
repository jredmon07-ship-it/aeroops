/**
 * Postgres enum types shared across tables.
 *
 * MEMBERSHIP_ROLES is imported from @aeroops/core as the single
 * source of truth so that the DB enum and application-layer types
 * cannot drift apart.
 *
 * RESOURCE_KINDS and RESERVATION_STATUSES are likewise imported from
 * @aeroops/core as the single source of truth for scheduling enum types
 * (ADR-0004). The core module re-exports them from scheduling/enums.ts.
 */
import { pgEnum } from 'drizzle-orm/pg-core';
import { MEMBERSHIP_ROLES, RESOURCE_KINDS, RESERVATION_STATUSES } from '@aeroops/core';

/**
 * membershipRole — Postgres enum `membership_role`.
 * Derived from the @aeroops/core MEMBERSHIP_ROLES tuple so the
 * application type and DB type are guaranteed in sync.
 */
export const membershipRole = pgEnum('membership_role', MEMBERSHIP_ROLES);

/**
 * resourceKind — Postgres enum `resource_kind`.
 * Derived from the @aeroops/core RESOURCE_KINDS tuple (scheduling/enums.ts)
 * so the application type and DB type are guaranteed in sync.
 * Slice 1 only populates aircraft + instructor; sim/room/vehicle are
 * forward-compatible data changes, not schema changes (ADR-0004).
 */
export const resourceKind = pgEnum('resource_kind', RESOURCE_KINDS);

/**
 * reservationStatus — Postgres enum `reservation_status`.
 * Derived from the @aeroops/core RESERVATION_STATUSES tuple.
 * The EXCLUDE constraint only fires for status='booked' rows.
 */
export const reservationStatus = pgEnum('reservation_status', RESERVATION_STATUSES);
