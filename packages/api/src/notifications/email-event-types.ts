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
 * airworthiness/currency determinations, no money advice.
 */

export const NOTIFICATION_EVENT_TYPES = [
  'reservation.created',
  'squawk.reported',
  'aircraft.grounded',
  'invoice.finalized',
  'payment.failed',
  'dues.generated',
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

export interface SquawkReportedData {
  resourceId: string;
  title: string;
  severity: string;
}

export interface AircraftGroundedData {
  resourceId: string;
  reason: string;
}

export interface InvoiceFinalizedData {
  invoiceId: string;
  totalCents: number;
}

export interface PaymentFailedData {
  invoiceId: string;
  amountCents: number;
}

export interface DuesGeneratedData {
  invoiceId: string;
  periodKey: string;
  amountCents: number;
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
  'squawk.reported': SquawkReportedData;
  'aircraft.grounded': AircraftGroundedData;
  'invoice.finalized': InvoiceFinalizedData;
  'payment.failed': PaymentFailedData;
  'dues.generated': DuesGeneratedData;
  'maintenance.due': MaintenanceDueData;
  'org.announcement': OrgAnnouncementData;
}

/** The rendered output of a template — text-first; html is a simple wrapper. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}
