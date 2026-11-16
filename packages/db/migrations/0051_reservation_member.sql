-- ============================================================
-- AeroOps — Reservation "booked for" member
-- Migration: 0051_reservation_member.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0050_dues_cadence.sql must
--               already be applied.
--
-- CONTEXT: renters and students hold only app:access + portal:access, so club
-- staff make their bookings and reservation.created_by is the staff member.
-- Who a booking was FOR lived only in the free-text notes ("Riley — club
-- currency flight"), so the member portal, the member page and the alerts bell
-- never found it: the member saw "No upcoming reservations". This adds
-- reservation.member_user_id, the member the booking is for.
--
-- Key guarantees:
--   (1) STRICTLY ADDITIVE — one new NULLABLE column with no DEFAULT (a
--       catalog-only ADD COLUMN, no table rewrite), one composite FK, one
--       partial index. Every existing row keeps member_user_id NULL, and a
--       create that names no member writes NULL: today's row exactly.
--   (2) SAME-ORG INTEGRITY, the created_by / cancelled_by way (0002): a
--       composite FK (member_user_id, org_id) → app_user(id, org_id), so a
--       booking can only name a user of its own org. app_user's UNIQUE
--       (id, org_id) (0000) is the referenced key. Like every nullable
--       composite FK here, it only fires when member_user_id IS NOT NULL.
--   (3) ON DELETE SET NULL ("member_user_id") — the choice cancelled_by made
--       for the other NULLABLE who-column: deleting the user keeps the booking
--       (a record) and drops only the link. created_by's RESTRICT stays the
--       rule for the NOT NULL creator column, which cannot be nulled. The
--       column list matters on a COMPOSITE key: a bare SET NULL would also null
--       org_id (NOT NULL) and the delete would fail; this Postgres 15+ form
--       nulls member_user_id alone, as 0006 does for squawk.resolved_by.
--       (The app never hard-deletes users — People deactivates them — so this
--       only governs a manual delete or the org-delete cascade.)
--   (4) RLS + GRANTS UNCHANGED: reservation already has ENABLE + FORCE RLS and
--       its four org-scoped policies (0002); a new column falls under them.
--       aeroops_app's grant on reservation is TABLE-level (GRANT SELECT,
--       INSERT, UPDATE, DELETE ON "reservation" in 0002) and no migration
--       grants or revokes reservation columns individually, so it covers
--       member_user_id with no new GRANT.
--   (5) NOT A RESOURCE: member_user_id takes no part in the EXCLUDE
--       constraint, the conflict probe or the booking gates (ADR-0004/0005
--       unchanged). It is written only by the shared create path
--       (gatedCreateOccurrence), which checks it names an ACTIVE member.
--
-- ORDER within this file:
--   (1) ADD COLUMN reservation.member_user_id (nullable)
--   (2) ADD the composite FK
--   (3) CREATE the partial index for the "bookings for this member" reads
-- ============================================================


-- ── (1) ADD COLUMN ────────────────────────────────────────────────────────────
-- Nullable: NULL = the booking names no member (staff-only, CFI-alone, or any
-- booking made before this migration).

ALTER TABLE "reservation" ADD COLUMN "member_user_id" uuid;


-- ── (2) Composite FK: the member must be a user in the SAME org ──────────────

ALTER TABLE "reservation"
  ADD CONSTRAINT "reservation_member_user_id_org_fk"
    FOREIGN KEY ("member_user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE SET NULL ("member_user_id");


-- ── (3) Partial index ─────────────────────────────────────────────────────────
-- Covers: the member's own reads (portal upcoming reservations, the member
-- page, the alerts bell) WHERE member_user_id = $me, scoped to the org; and the
-- FK's ON DELETE lookup. Partial: most bookings name no member, so NULL rows
-- stay out of it.

CREATE INDEX "reservation_org_id_member_user_id_idx"
  ON "reservation" ("org_id", "member_user_id")
  WHERE "member_user_id" IS NOT NULL;
