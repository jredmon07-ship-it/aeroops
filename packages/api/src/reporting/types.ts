/**
 * reporting/types.ts — Shared output types for R1.1 report reads.
 *
 * All types are OPERATIONAL operator data — NO money, NO billing, NO computed
 * FAA determination, NO airworthiness statement.
 *
 * [VERIFY-A]   Hours = Hobbs-derived operational utilization; NOT billing/airworthiness.
 * [VERIFY-T1-B] Training counts = operator state; NOT Part-141 or FAA determination.
 * [VERIFY-M1-A] Maintenance counts = operator data; NOT Part-43/airworthiness/RTS.
 * [VERIFY-R1-TZ] All bucketing UTC; display layer handles localisation.
 */

import type { ReportRangeKey, BucketGranularity } from './internal.js';

export type { ReportRangeKey, BucketGranularity };

// ─── Shared range header ──────────────────────────────────────────────────────

export interface ReportRange {
  key: ReportRangeKey;
  /** Inclusive lower bound (UTC). */
  from: Date;
  /** Exclusive upper bound (UTC), equals the request time. */
  to: Date;
}

// ─── Utilization trend ────────────────────────────────────────────────────────

/**
 * UtilizationTrendBucket — one row per UTC bucket.
 *
 * [VERIFY-A] flightHours = Hobbs-derived operational utilization.
 * NOT billing or airworthiness hours.
 */
export interface UtilizationTrendBucket {
  /** UTC-aligned bucket start (midnight for day; Monday 00:00 for week). */
  bucketStart: Date;
  /** COUNT of closed dispatch tickets with closed_at in this bucket. */
  flightCount: number;
  /**
   * SUM of flight_time_hours for closed tickets in this bucket, rounded to 1dp.
   * OPERATIONAL — NOT billing or logbook-authoritative. [VERIFY-A]
   */
  flightHours: number;
}

/**
 * UtilizationTrendResult — R1.1 utilization-over-time report.
 *
 * [VERIFY-A] totalFlightHours and per-bucket flightHours are OPERATIONAL figures
 * derived from recorded Hobbs at check-in. NOT billable or airworthiness hours.
 */
export interface UtilizationTrendResult {
  range:       ReportRange;
  granularity: BucketGranularity;
  /**
   * Zero-filled bucket rows. Every bucket in [from, to) appears even if empty.
   * Maximum: 30 rows (30d/day), 7 rows (7d/day), ~53 rows (365d/week).
   */
  buckets: UtilizationTrendBucket[];
  /** Total closed flights in the range. */
  totalFlights: number;
  /**
   * Sum of flight_time_hours for closed tickets in range, rounded to 1dp.
   * OPERATIONAL — NOT billing. [VERIFY-A]
   */
  totalFlightHours: number;
  /**
   * safeAvg(totalFlightHours, totalFlights): 0 when no flights.
   * OPERATIONAL — NOT billing. [VERIFY-A]
   */
  avgHoursPerFlight: number;
}

// ─── Reservations vs Flights trend ───────────────────────────────────────────

/**
 * ReservationsVsFlightsBucket — one row per UTC bucket, two series.
 *
 * reservationsCreated INCLUDES cancelled reservations (creation-activity metric).
 */
export interface ReservationsVsFlightsBucket {
  /** UTC-aligned bucket start. */
  bucketStart: Date;
  /**
   * COUNT of reservation rows with created_at in this bucket (ALL statuses,
   * including cancelled). Creation-activity signal, not confirmed bookings.
   */
  reservationsCreated: number;
  /** COUNT of dispatch_ticket rows with status='closed' and closed_at in this bucket. */
  flightsClosed: number;
}

/**
 * ReservationsVsFlightsTrendResult — R1.1 reservations-vs-flights trend.
 *
 * Label guidance: "Reservations created includes cancelled — creation activity,
 * not confirmed bookings." Web layer is responsible for displaying this label.
 */
export interface ReservationsVsFlightsTrendResult {
  range:       ReportRange;
  granularity: BucketGranularity;
  /** Zero-filled bucket rows. */
  buckets: ReservationsVsFlightsBucket[];
  /**
   * Total reservation rows created in range (ALL statuses incl. cancelled).
   * Creation-activity metric.
   */
  totalReservationsCreated: number;
  /** Total closed dispatch tickets in range. */
  totalFlightsClosed: number;
}

// ─── Training throughput ──────────────────────────────────────────────────────

/**
 * TrainingThroughputResult — R1.1 training activity counts.
 *
 * [VERIFY-T1-B] All counts are OPERATIONAL operator state — NOT a Part-141 or
 * FAA training graduation, currency, or completion determination.
 */
export interface TrainingThroughputResult {
  range: ReportRange;
  /**
   * Count of enrollment rows with enrolled_at in [from, to).
   * OPERATIONAL — NOT a Part-141 or FAA training determination. [VERIFY-T1-B]
   */
  enrollmentsCreatedInRange: number;
  /**
   * Count of enrollment rows with status='completed' AND status_changed_at in [from, to).
   * OPERATIONAL — NOT a Part-141 graduation or FAA completion determination. [VERIFY-T1-B]
   */
  enrollmentsCompletedInRange: number;
  /**
   * Count of lesson_record rows with status='recorded' AND completed_at in [from, to).
   * Voided records excluded.
   * OPERATIONAL — NOT an FAA logbook, Part-141/61 endorsement, or ACS outcome. [VERIFY-T1-B]
   */
  lessonsRecordedInRange: number;
  /**
   * Point-in-time count of enrollment rows with status='active'.
   * OPERATIONAL — NOT a Part-141 or FAA training determination. [VERIFY-T1-B]
   */
  activeEnrollmentCount: number;
}

// ─── Maintenance trend ────────────────────────────────────────────────────────

/**
 * MaintenanceTrendResult — R1.1 maintenance activity counts.
 *
 * [VERIFY-M1-A] All counts are OPERATIONAL operator data — NOT an airworthiness,
 * Part-43/91, return-to-service, or MEL status determination.
 */
export interface MaintenanceTrendResult {
  range: ReportRange;
  /**
   * COUNT of squawk rows with reported_at in [from, to).
   * OPERATIONAL — NOT an airworthiness or Part-43 determination. [VERIFY-M1-A]
   */
  squawksOpenedInRange: number;
  /**
   * COUNT of squawk rows with status='resolved' AND resolved_at in [from, to).
   * OPERATIONAL — NOT an RTS or Part-43 clearance. [VERIFY-M1-A]
   */
  squawksResolvedInRange: number;
  /**
   * COUNT of work_order rows with opened_at in [from, to).
   * OPERATIONAL — NOT an airworthiness or Part-43 determination. [VERIFY-M1-A]
   */
  workOrdersOpenedInRange: number;
  /**
   * COUNT of work_order rows with status='completed' AND signed_off_at in [from, to).
   * completed != RTS; sign-off = operator entry, not e-sig. [VERIFY-M1-A]
   */
  workOrdersCompletedInRange: number;
  /**
   * Point-in-time COUNT of squawk rows with status='open'.
   * OPERATIONAL — NOT an airworthiness status. [VERIFY-M1-A]
   */
  openSquawkCount: number;
  /**
   * Point-in-time count of active aircraft currently grounded per loadGroundingProbe
   * (same probe as dashboard + openDispatch).
   * Grounding = OPERATOR DATA — NOT a computed Part-91/43 determination. [VERIFY-M1-A]
   */
  groundedAircraftCount: number;
}
