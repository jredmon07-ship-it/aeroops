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
 *
 * RECURRENCE_FREQS, RECURRENCE_END_KINDS, RESERVATION_SERIES_STATUSES are
 * imported from @aeroops/core for the Slice 2b recurrence schema (ADR-0006).
 * The DB pgEnums and application-layer types are guaranteed in sync.
 */
import { pgEnum } from 'drizzle-orm/pg-core';
import {
  MEMBERSHIP_ROLES,
  RESOURCE_KINDS,
  RESERVATION_STATUSES,
  RECURRENCE_FREQS,
  RECURRENCE_END_KINDS,
  RESERVATION_SERIES_STATUSES,
} from '@aeroops/core';

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

/**
 * recurrenceFreq — Postgres enum `recurrence_freq`.
 * Derived from the @aeroops/core RECURRENCE_FREQS tuple (ADR-0006).
 * Slice 2b supports 'weekly' only; the single-value tuple is intentional —
 * adding 'monthly'/'yearly' later is a data change, not an enum change.
 */
export const recurrenceFreq = pgEnum('recurrence_freq', RECURRENCE_FREQS);

/**
 * recurrenceEndKind — Postgres enum `recurrence_end_kind`.
 * Derived from the @aeroops/core RECURRENCE_END_KINDS tuple (ADR-0006).
 * Exactly one of 'count' (number of occurrences, ≤52) or 'until' (local
 * calendar end date) bounds a series; the end_shape_check CHECK constraint
 * enforces the XOR invariant.
 */
export const recurrenceEndKind = pgEnum('recurrence_end_kind', RECURRENCE_END_KINDS);

/**
 * reservationSeriesStatus — Postgres enum `reservation_series_status`.
 * Derived from the @aeroops/core RESERVATION_SERIES_STATUSES tuple (ADR-0006).
 * 'active' on create; 'cancelled' after cancelSeries.
 */
export const reservationSeriesStatus = pgEnum(
  'reservation_series_status',
  RESERVATION_SERIES_STATUSES,
);
