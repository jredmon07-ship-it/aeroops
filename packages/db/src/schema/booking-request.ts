/**
 * booking_request — an unauthenticated (anon) inbound booking enquiry from a
 * prospective customer via the public booking page (/book/[slug]).
 *
 * ── Security model (ADR-0013) ────────────────────────────────────────────────
 * There is NO session on the public page. The submit path:
 *   (a) resolves org_id ONLY via resolveOrgBySlug (server-side, never from
 *       client input — the wire body contains NO org_id or slug);
 *   (b) runs the INSERT inside withOrgContext(db, resolvedOrg.id, ...) so that
 *       the RLS `booking_request_insert WITH CHECK (org_id = current_org_id)`
 *       is the structural backstop — a bug cannot smuggle a different org_id.
 *   (c) does NOT use withPlatformAdminContext (which would bypass RLS).
 *
 * INVARIANT (reviewer must reject any violation): the anon tx body is
 * INSERT-only; org_id is bound ONLY from resolveOrgBySlug.
 *
 * ── Tenant scope ─────────────────────────────────────────────────────────────
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0015).
 *
 * ── Records posture ──────────────────────────────────────────────────────────
 * Requester fields (requester_name / requester_email / requester_phone /
 * requested_start / requested_end / aircraft_type_pref / message) are
 * WRITE-ONCE — set at INSERT, never mutated. This protects the integrity of
 * the original enquiry.
 *
 * Triage fields (status / handled_by / handled_at / triage_notes) are
 * staff-mutable only (session-gated, normal RLS path, booking:triage cap).
 * Status changes are audited (one audit_log row per transition).
 *
 * ── Composite FKs (hand-written in migration 0015 / 0016 SQL) ───────────────
 * Drizzle's .references() cannot express multi-column FKs; composite FKs are
 * written in the migration; affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE
 *     Tenant spine — deleting an org cascades to its booking requests.
 *     Named: booking_request_org_id_fk. Also expressed via .references() on
 *     orgId for Drizzle-level ergonomics (simple FK; named composite FK in SQL).
 *
 *   Composite FK (handled_by, org_id) → app_user(id, org_id) ON DELETE SET NULL
 *     Named: booking_request_handled_by_org_fk. Column-list syntax (CRITICAL):
 *     ON DELETE SET NULL (handled_by, org_id) would clear org_id — NOT what we
 *     want. The FK targets app_user(id, org_id) but ON DELETE SET NULL is
 *     scoped to handled_by ONLY (column-list SET NULL). This is handled_by
 *     carrying no .references() and the FK written manually in migration 0015
 *     with column-list ON DELETE SET NULL (handled_by). org_id is NEVER nulled.
 *     Durable "who" lives in audit_log. Mirrors squawk_resolved_shape_check
 *     rationale: resolver identity may become NULL after a user hard-delete.
 *     Targets app_user_id_org_id_unique from migration 0000.
 *
 *   Composite FK (converted_reservation_id, org_id) → reservation(id, org_id)
 *     ON DELETE SET NULL (converted_reservation_id)
 *     Named: booking_request_converted_reservation_org_fk (ADR-0014).
 *     Set when a request is converted to a reservation (PB2.1a).
 *     Column-list SET NULL: only converted_reservation_id is nulled on
 *     reservation delete; org_id is NEVER touched. A cross-org link is
 *     structurally impossible — the composite FK targets reservation(id, org_id)
 *     via reservation_id_org_id_unique (migration 0002), so pairing a
 *     reservation_id from org B with org A's org_id will always fail the FK.
 *     Hand-written in migration 0016; convertedReservationId carries NO
 *     .references() here. Note: the shape-check (booking_request_handled_shape_check)
 *     is UNCHANGED — a converted row with a NULL converted_reservation_id is
 *     valid (SET NULL action post-delete; PB1 flag-only converted rows). The
 *     converted-with-a-reservation invariant lives in the command layer (ADR-0014).
 *
 * NO requester FK: the requester is anonymous by design — no app_user row.
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * booking_request_status_check:
 *   status IN ('new', 'contacted', 'converted', 'declined')
 *
 * booking_request_requester_name_nonempty_check:
 *   char_length(btrim(requester_name)) > 0
 *
 * booking_request_requester_email_nonempty_check:
 *   char_length(btrim(requester_email)) > 0
 *
 * booking_request_end_after_start_check:
 *   requested_end IS NULL OR requested_end > requested_start
 *
 * booking_request_handled_shape_check:
 *   status = 'new'
 *     ⇒ handled_by IS NULL AND handled_at IS NULL
 *   status IN ('contacted', 'converted', 'declined')
 *     ⇒ handled_at IS NOT NULL
 *   (handled_by is intentionally NOT in the NOT-NULL arm: it is ON DELETE SET
 *   NULL so the handler identity may be nulled on a user hard-delete.
 *   handled_at + triage_notes persist, and the durable "who" lives in
 *   audit_log. Mirrors squawk_resolved_shape_check rationale.)
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — forward-compat for future composite FKs and
 * consistent with all other tenant tables.
 *
 * ── Index ─────────────────────────────────────────────────────────────────────
 * booking_request_org_status_created_idx (org_id, status, created_at DESC)
 *   Covers: triage inbox (ORDER BY created_at DESC filtered by status) AND the
 *   per-org rate-count guard (COUNT for org_id in last N seconds where status='new').
 */
import {
  pgTable,
  uuid,
  timestamp,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const bookingRequest = pgTable(
  'booking_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — simple FK covers Drizzle ergonomics; the named composite FK
    // booking_request_org_id_fk is hand-written in migration 0015.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // Status domain: new → contacted | declined; contacted → converted | declined.
    // Default 'new' — every anon submission starts in triage inbox.
    // booking_request_status_check enforces the four-value domain.
    status: text('status').notNull().default('new'),

    // ── Write-once requester fields ─────────────────────────────────────────────
    // Set at INSERT, never mutated. Protect integrity of the original enquiry.
    // booking_request_requester_name_nonempty_check: btrim(requester_name) non-empty.
    requesterName: text('requester_name').notNull(),

    // booking_request_requester_email_nonempty_check: btrim(requester_email) non-empty.
    // Format validation (RFC 5321 compliance ≤254 chars) is enforced in the app layer.
    requesterEmail: text('requester_email').notNull(),

    // Optional free-text phone (≤40 chars enforced at app layer only).
    requesterPhone: text('requester_phone'),

    // Requested date/time of the flight. Required.
    requestedStart: timestamp('requested_start', { withTimezone: true }).notNull(),

    // Optional end time. booking_request_end_after_start_check enforces end > start.
    requestedEnd: timestamp('requested_end', { withTimezone: true }),

    // FREE-TEXT requester preference — no fleet list shown, no FK. ≤80 chars at app layer.
    aircraftTypePref: text('aircraft_type_pref'),

    // Optional free-text message from the requester. ≤2000 chars at app layer.
    message: text('message'),

    // ── Staff-mutable triage fields ─────────────────────────────────────────────
    // handled_by carries no .references() — composite FK
    // (handled_by, org_id) → app_user(id, org_id) ON DELETE SET NULL (handled_by)
    // is hand-written in migration 0015 with column-list SET NULL syntax so that
    // only handled_by is nulled and org_id is NEVER touched.
    handledBy: uuid('handled_by'),

    handledAt: timestamp('handled_at', { withTimezone: true }),

    // Operator triage notes (free-text). Mutable by staff.
    triageNotes: text('triage_notes'),

    // Set when a request is successfully converted to a reservation (ADR-0014,
    // PB2.1a). NULL until conversion, and also NULL if the linked reservation is
    // later hard-deleted (ON DELETE SET NULL — column-list syntax so org_id is
    // NEVER cleared). The booking_request_handled_shape_check is UNCHANGED:
    // a converted row with a null link is valid (SET NULL action or PB1 flag-only
    // converted rows). The converted-with-a-reservation invariant lives in the
    // command layer (ADR-0014), not a DB CHECK.
    //
    // Carries NO .references() — composite FK
    // (converted_reservation_id, org_id) → reservation(id, org_id)
    // ON DELETE SET NULL (converted_reservation_id)
    // is hand-written in migration 0016 (booking_request_converted_reservation_org_fk).
    // Targets reservation_id_org_id_unique (migration 0002).
    // Cross-org link is structurally impossible via the composite FK.
    convertedReservationId: uuid('converted_reservation_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — forward-compat for future composite FKs.
    // Consistent with all other tenant tables.
    uniqueIndex('booking_request_id_org_id_unique').on(t.id, t.orgId),

    // Covers: triage inbox (newest-first per status) + per-org rate-count guard.
    // e.g. listBookingRequests: WHERE org_id=$1 [AND status=$2] ORDER BY created_at DESC
    //      rate guard:          WHERE org_id=$1 AND created_at > now()-interval AND status='new'
    index('booking_request_org_status_created_idx').on(t.orgId, t.status, t.createdAt),
  ],
);

export type BookingRequestSelect = typeof bookingRequest.$inferSelect;
export type BookingRequestInsert = typeof bookingRequest.$inferInsert;
