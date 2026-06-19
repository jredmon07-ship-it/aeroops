-- ============================================================
-- AeroOps — Phase 1 Slice 5.1: Fleet aircraft-identity columns
-- Migration: 0007_fleet.sql
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
--               + 0006_squawks_grounding.sql
--               must already be applied.
--
-- Adds aircraft-identity columns to the existing `resource` table
-- (additive only — no table, enum, or constraint is removed or altered).
-- Adds a composite candidate key to `location` as the FK target.
--
-- Key guarantees:
--   (1) All new resource columns are nullable (or NOT NULL DEFAULT true for
--       the boolean flags) — existing rows and existing INSERT statements
--       that omit the new columns continue to succeed unchanged.
--   (2) resource_kind_shape_check is NOT widened and is left byte-for-byte
--       intact. The new columns are outside it (not required for any kind).
--   (3) home_base_location_id uses a composite FK
--       (home_base_location_id, org_id) → location(id, org_id) with
--       ON DELETE SET NULL (home_base_location_id) — column-list SET-NULL
--       syntax (PG 15+) so only the nullable FK column is nulled, never
--       the NOT NULL org_id column (same fix as squawk/aircraft_grounding
--       in 0006).
--   (4) The location_id_org_id_unique UNIQUE constraint is added FIRST
--       (step 1) because it is required as the FK target for step 4.
--   (5) resource_year_sane_check: sanity bound only (1900–2200), NOT a
--       regulatory claim.
--   (6) No RLS changes: resource is already ENABLE + FORCE RLS with 4
--       policies from migration 0002. No new tables, so no new RLS needed.
--   (7) No new grants: aeroops_app already holds SELECT/INSERT/UPDATE/DELETE
--       on resource from migration 0002. No new tables, so no new grants.
--
-- Compliance: light. No new reg claims; display/config only.
--   [VERIFY-5-A] current-meter display = "last recorded" reading (latest
--     closed dispatch ticket's _in fields), NOT a live/authoritative airframe
--     total or maintenance value.
--   [VERIFY-5-B] grounding banner reuses [VERIFY-3b-H]: operator-data
--     language only, never "not airworthy".
--   has_hobbs / has_tach are display/config flags ONLY — they do NOT alter
--     the FROZEN ADR-0007 dispatch meter-capture path.
--
-- Phase 4 maintenance will add nullable inspection columns to resource —
-- documented forward seam, NOT built in Slice 5 (no inspection/AD/
-- airworthiness computation in Phase 1).
--
-- ORDER:
--   (1) ALTER TABLE location ADD CONSTRAINT location_id_org_id_unique
--       UNIQUE (id, org_id)       ← REQUIRED precursor: FK target for step 4
--   (2) Seven ALTER TABLE resource ADD COLUMN statements
--   (3) ALTER TABLE resource ADD CONSTRAINT resource_year_sane_check CHECK (...)
--   (4) ALTER TABLE resource ADD CONSTRAINT resource_home_base_org_fk
--       FOREIGN KEY (home_base_location_id, org_id)
--       REFERENCES location(id, org_id) ON DELETE SET NULL (home_base_location_id)
-- ============================================================


-- ── (1) Add composite candidate key to location ───────────────────────────────
-- Required as the FK target for the home_base_location_id composite FK below.
-- Mirrors the resource / app_user / dispatch_ticket / squawk candidate-key
-- pattern established in migrations 0002, 0000, 0005, and 0006 respectively.
-- MUST be created before step (4) references it.

ALTER TABLE "location"
  ADD CONSTRAINT "location_id_org_id_unique" UNIQUE ("id", "org_id");


-- ── (2) Add aircraft-identity + meter-config columns to resource ──────────────
-- All seven columns are additive; no existing row or INSERT is affected.
-- The two boolean columns (has_hobbs, has_tach) are NOT NULL DEFAULT true so
-- they are back-filled silently on existing rows and new INSERTs that omit them
-- continue to default to true. The remaining five are nullable.

ALTER TABLE "resource" ADD COLUMN "make"                   text;
ALTER TABLE "resource" ADD COLUMN "model"                  text;
ALTER TABLE "resource" ADD COLUMN "year"                   integer;
ALTER TABLE "resource" ADD COLUMN "serial_number"          text;
ALTER TABLE "resource" ADD COLUMN "home_base_location_id"  uuid;
ALTER TABLE "resource" ADD COLUMN "has_hobbs"              boolean NOT NULL DEFAULT true;
ALTER TABLE "resource" ADD COLUMN "has_tach"               boolean NOT NULL DEFAULT true;


-- ── (3) Year sanity check ─────────────────────────────────────────────────────
-- Rejects obviously wrong years. NULL is always allowed (the column is
-- optional). This is a data-sanity bound ONLY, not a regulatory claim.

ALTER TABLE "resource"
  ADD CONSTRAINT "resource_year_sane_check"
  CHECK ("year" IS NULL OR ("year" BETWEEN 1900 AND 2200));


-- ── (4) Composite FK: home_base_location_id → location(id, org_id) ────────────
-- Prevents linking an aircraft's home base to a location in a different org.
-- Drizzle's .references() cannot express multi-column FKs; this constraint is
-- hand-written here (same pattern as resource_instructor_user_org_fk in 0002,
-- squawk/aircraft_grounding composite FKs in 0006).
--
-- ON DELETE SET NULL (home_base_location_id): PG 15+ column-list SET-NULL syntax.
-- When the referenced location row is deleted, only home_base_location_id is set
-- to NULL. org_id is NOT nulled (it is NOT NULL and NOT in the column list).
-- This is the same fix used for squawk_dispatch_ticket_org_fk,
-- squawk_resolved_by_org_fk, aircraft_grounding_squawk_org_fk, and
-- aircraft_grounding_dispatch_ticket_org_fk in migration 0006.
--
-- The composite FK fires only when home_base_location_id IS NOT NULL (standard
-- Postgres NULL-FK behaviour for composite FKs with a nullable leading column).
-- Requires location(id, org_id) UNIQUE "location_id_org_id_unique" — added in
-- step (1) above.

ALTER TABLE "resource"
  ADD CONSTRAINT "resource_home_base_org_fk"
  FOREIGN KEY ("home_base_location_id", "org_id")
  REFERENCES "location"("id", "org_id")
  ON DELETE SET NULL ("home_base_location_id");
