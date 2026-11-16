/**
 * notifications/email-event-types.ts — event-type registry + template-data
 * map for EMAIL notifications (Slice P1.3). Framework-agnostic; no I/O.
 *
 * NAMED "email-event-types" (not "types") because notifications/types.ts is
 * already the (unrelated, pre-existing) result-type module for Slice N1's
 * in-app alerts bell (AlertKind / MyAlert / MyAlertsResult) — this module
 * must not collide with it.
 *
 * NOTIFICATION_EVENT_TYPES is the exhaustive list of events this slice can
 * send an email for. Adding a new event type means:
 *   1. Add the string here.
 *   2. Add its TemplateData interface + branch to templates.ts.
 *   3. Wire a hook (web-action-layer, best-effort, post-commit).
 * No migration is required — notification_log.event_type and
 * notification_pref.event_type are free text (see migration 0026).
 *
 * PLAIN, operator-operational copy only — see templates.ts. NO FAA/
 * airworthiness/currency determinations.
 */

export const NOTIFICATION_EVENT_TYPES = [
  'reservation.created',
  // Club staff booked, moved or cancelled a booking FOR this member
  // (reservation.member_user_id, migration 0051). Listed next to
  // reservation.created so the settings page groups the two booking e-mails.
  'reservation.for_member',
  'squawk.reported',
  'aircraft.grounded',
  'maintenance.due',
  'org.announcement',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

/** Runtime guard — used by setMyNotificationPref to validate raw input. */
export function isNotificationEventType(value: unknown): value is NotificationEventType {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value)
  );
}

// ─── Per-event template data ──────────────────────────────────────────────────

export interface ReservationCreatedData {
  startAt: Date;
  endAt: Date;
  /** Resource ids booked (tail-number lookup is a deferred display polish). */
  resourceIds: string[];
}

/**
 * What a booking is for, as people read it: an aircraft's tail number (its
 * display name when it has none), an instructor's display name, any other
 * resource's display name (simulator, room, vehicle). NEVER a resource id.
 */
export interface BookingResourceLabels {
  aircraft: string[];
  instructors: string[];
  otherResources: string[];
}

/**
 * ReservationForMemberSeries — one e-mail for a whole recurring booking, not
 * one per date. The parent's startAt/endAt are the FIRST booking it covers.
 */
export interface ReservationForMemberSeries {
  /** How many bookings the change covers: booked, or cancelled. */
  count: number;
  /** ISO weekdays 1..7 (Mon..Sun) the series repeats on. */
  weekdays: number[];
  /** Repeats every N weeks (1 = every week). */
  intervalWeeks: number;
  /** Start of the LAST booking it covers. */
  lastStartAt: Date;
}

interface ReservationForMemberBase extends BookingResourceLabels {
  startAt: Date;
  endAt: Date;
  /**
   * IANA zone the times are written in. The template prints the zone's short
   * name next to them ("10:00–11:30 CST"); an unknown zone falls back to an
   * explicit "UTC". Never a bare clock time.
   */
  timeZone: string;
  /** Display name of the staff member who made the change. */
  changedBy: string;
  /** The org's name ("at Bravo Flying Club"); omitted from the copy when empty. */
  orgName: string;
  /** Present when the change covers a recurring series. */
  series?: ReservationForMemberSeries;
}

/**
 * ReservationForMemberData — 'reservation.for_member': club staff booked,
 * moved or cancelled a booking FOR this member (reservation.member_user_id,
 * migration 0051). The member never made the change, so the e-mail says who
 * did. Discriminated on `change`:
 *   booked    — a new booking (or recurring series) for them.
 *   moved     — `previous` is the window it was moved from (and the labels
 *               it had, when the aircraft or instructor changed too).
 *   cancelled — `reason` is the reason staff gave, null when none was.
 * Labels only (BookingResourceLabels) — never ids. PLAIN operator copy; NO
 * FAA/currency/airworthiness determination (templates.ts).
 */
export type ReservationForMemberData =
  | (ReservationForMemberBase & { change: 'booked' })
  | (ReservationForMemberBase & {
      change: 'moved';
      previous: { startAt: Date; endAt: Date } & Partial<BookingResourceLabels>;
    })
  | (ReservationForMemberBase & { change: 'cancelled'; reason: string | null });

export interface SquawkReportedData {
  resourceId: string;
  title: string;
  severity: string;
}

export interface AircraftGroundedData {
  resourceId: string;
  reason: string;
}

/**
 * MaintenanceDueData — Slice P1.5's "heads-up" digest data for
 * notifyMaintenanceDue. `items` is bounded (≤10, caller-side) — this is a
 * heads-up, not an exhaustive report. `status` is 'overdue' | 'due_soon'
 * only (never 'ok'/'unknown' — those are never notified). OPERATOR-ENTERED
 * tracking data; NO FAA/Part-43/91.409 determination. [VERIFY-P1.5-A]
 */
export interface MaintenanceDueData {
  overdueCount: number;
  dueSoonCount: number;
  items: { title: string; status: string }[];
}

/**
 * OrgAnnouncementData — Slice FC-P1's operator-authored member message.
 * `subject`/`body` are the OPERATOR'S OWN free text, carried VERBATIM (never
 * transformed/summarized) — the template appends a standard footer naming
 * the org so the recipient always knows who sent it. `body` is rendered as
 * PLAIN TEXT ONLY — no HTML interpretation, no injection surface.
 */
export interface OrgAnnouncementData {
  subject: string;
  body: string;
  orgName: string;
}

/** Maps each event type to its typed template-data shape. */
export interface NotificationTemplateDataMap {
  'reservation.created': ReservationCreatedData;
  'reservation.for_member': ReservationForMemberData;
  'squawk.reported': SquawkReportedData;
  'aircraft.grounded': AircraftGroundedData;
  'maintenance.due': MaintenanceDueData;
  'org.announcement': OrgAnnouncementData;
}

/** The rendered output of a template — text-first; html is a simple wrapper. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}
