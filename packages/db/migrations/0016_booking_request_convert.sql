-- ============================================================
-- AeroOps — Slice PB2.1a: converted_reservation_id column
-- Migration: 0016_booking_request_convert.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql + 0001_auth_credential.sql
--               + 0002_scheduling.sql + 0003_booking_policies.sql
--               + 0004_recurrence.sql + 0005_dispatch.sql
--               + 0006_squawks_grounding.sql + 0007_fleet.sql
--               + 0008_people.sql + 0009_dispatch_gate.sql
--               + 0010_civil_twilight.sql + 0011_optimizer_run.sql
--               + 0012_training.sql + 0013_work_orders.sql
--               + 0014_availability.sql + 0015_booking_request.sql
--               must already be applied.
--
-- Adds the Slice PB2.1a data-model delta:
--   (1) ALTER TABLE booking_request ADD COLUMN converted_reservation_id uuid
--   (2) ALTER TABLE booking_request ADD CONSTRAINT
--         booking_request_converted_reservation_org_fk
--         FOREIGN KEY (converted_reservation_id, org_id)
--         REFERENCES reservation(id, org_id)
--         ON DELETE SET NULL (converted_reservation_id)
--
-- ── ADR-0014 — Convert is a composite ATOMIC command ─────────────────────────
-- Creating the reservation and marking the request as 'converted' happen in
-- ONE transaction (throw-to-rollback; FOR UPDATE on the request row serializes
-- concurrent converts). converted_reservation_id is set on commit; on failure
-- the request remains new/contacted and the column stays NULL.
--
-- ── Security / tenant-isolation model ────────────────────────────────────────
-- The composite FK (converted_reservation_id, org_id) → reservation(id, org_id)
-- targets reservation_id_org_id_unique (established in migration 0002). A
-- cross-org link — pairing a reservation_id from org B with org A's org_id —
-- is STRUCTURALLY IMPOSSIBLE: the composite tuple (reservation_id, org_id) must
-- exist in the reservation table with THAT exact org_id.
--
-- Column-list ON DELETE SET NULL (converted_reservation_id):
--   If the linked reservation is hard-deleted, only converted_reservation_id
--   is nulled. org_id is NEVER touched (same pattern as
--   booking_request_handled_by_org_fk in migration 0015 and the
--   dispatch_ticket.closed_by fix guidance).
--
-- ── Shape-check invariant ─────────────────────────────────────────────────────
-- booking_request_handled_shape_check is NOT modified. A converted row with a
-- NULL converted_reservation_id is valid: (a) the SET NULL action after a
-- reservation hard-delete, (b) PB1 flag-only converted rows. The
-- converted-with-a-reservation invariant lives in the command layer (ADR-0014).
--
-- ── Ride-along RLS / GRANT ───────────────────────────────────────────────────
-- No new RLS policy or GRANT is added. The new column is fully covered by the
-- four existing booking_request policies (select/insert/update/delete) that
-- filter by org_id = current_org_id GUC. aeroops_app already has SELECT,
-- INSERT, UPDATE, DELETE on booking_request.
--
-- ── Index ─────────────────────────────────────────────────────────────────────
-- No new index. Lookups via converted_reservation_id are rare (one per convert
-- confirmation); the existing booking_request_org_status_created_idx covers
-- triage inbox queries.
--
-- ── Strictly additive ─────────────────────────────────────────────────────────
-- Does NOT modify any existing table (other than the booking_request ALTER),
-- constraint, index, RLS policy, or data. No other tables altered.
-- NEVER applied to a real DB without explicit human sign-off.
-- ============================================================


-- ── (1) Add the nullable column ───────────────────────────────────────────────
--
-- converted_reservation_id: NULL until a booking_request is converted to a
-- reservation via convertBookingRequest (ADR-0014). Also NULL if the linked
-- reservation is subsequently hard-deleted (ON DELETE SET NULL below).

ALTER TABLE "booking_request"
  ADD COLUMN "converted_reservation_id" uuid;


-- ── (2) Composite FK → reservation(id, org_id) ON DELETE SET NULL ────────────
--
-- Targets reservation_id_org_id_unique (migration 0002).
-- Column-list ON DELETE SET NULL (converted_reservation_id): only
-- converted_reservation_id is nulled on reservation delete; org_id is preserved.
-- A cross-org pair (reservation_id from org B, org_id of org A) is rejected
-- by this FK because no such tuple exists in reservation_id_org_id_unique.

ALTER TABLE "booking_request"
  ADD CONSTRAINT "booking_request_converted_reservation_org_fk"
    FOREIGN KEY ("converted_reservation_id", "org_id")
    REFERENCES "reservation"("id", "org_id")
    ON DELETE SET NULL ("converted_reservation_id");
