-- ============================================================
-- AeroOps — Slice 6.1: People / Members (app_user additive columns + member_tag)
-- Migration: 0008_people.sql
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
--               must already be applied.
--
-- Adds People/Members support:
--   (1) app_user: two additive columns (phone, status) — existing rows
--       and existing INSERT statements that omit the new columns continue
--       to succeed unchanged (status back-fills to 'active' via DEFAULT).
--   (2) member_tag: new tenant-scoped table for free-text operator labels
--       attached to a member. Tags carry NO regulatory, currency, medical,
--       eligibility, or FAA meaning. [VERIFY-6-A]
--
-- Key guarantees:
--   (1) app_user ADD COLUMN phone is nullable — additive, no back-fill needed.
--   (2) app_user ADD COLUMN status is NOT NULL DEFAULT 'active' — existing rows
--       and existing INSERT statements that omit status are silently back-filled
--       to 'active'. No auth-behavior change.
--   (3) app_user_status_check CHECK (status IN ('active','inactive')) — text +
--       CHECK (not a pg enum) for additive/reversible two-value domain.
--   (4) 'inactive' does NOT block login in this slice. status is a ROSTER FLAG
--       only. Wiring inactive → login-refusal is deferred to a future auth slice.
--       [VERIFY-6-D]
--   (5) member_tag is tenant-scoped (org_id + ENABLE+FORCE RLS + 4 fail-closed
--       policies + composite FKs + aeroops_app grant), mirroring the byte-pattern
--       of 0002/0003/0004/0005/0006 exactly.
--   (6) member_tag.tag is FREE-TEXT only. [VERIFY-6-A]: no FAA currency, medical,
--       flight-review, Part 61/141, endorsement, or eligibility status is computed
--       or interpreted from a tag.
--   (7) Composite FKs on member_tag (hand-written; Drizzle cannot express multi-
--       column FKs):
--       (user_id, org_id) → app_user(id, org_id) ON DELETE CASCADE
--         Tags are disposable labels, not audited records — CASCADE is correct.
--         Targets app_user_id_org_id_unique established in migration 0000.
--       (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
--         Preserves attribution: prevents deleting the creating user while their
--         authorship record exists.
--   (8) member_tag_tag_nonempty_check CHECK (char_length(btrim(tag)) > 0)
--       Prevents blank-only or empty tags; UI trims before sending.
--   (9) UNIQUE (user_id, tag) — case-sensitive; same tag may exist on different
--       members.
--  (10) UNIQUE (id, org_id) — composite candidate key for future composite FKs,
--       consistent with all other tenant tables.
--  (11) Index member_tag_org_user_idx (org_id, user_id) — covers list-tags
--       queries: WHERE org_id = $1 AND user_id = $2.
--
-- ORDER:
--   (1) ALTER TABLE app_user ADD COLUMN phone
--   (2) ALTER TABLE app_user ADD COLUMN status
--   (3) ALTER TABLE app_user ADD CONSTRAINT app_user_status_check
--   (4) CREATE TABLE member_tag + 5 named constraints
--   (5) CREATE INDEX member_tag_org_user_idx
--   (6) ENABLE + FORCE RLS on member_tag
--   (7) 4 named RLS policies (SELECT, INSERT, UPDATE, DELETE)
--   (8) GRANT to aeroops_app
-- ============================================================


-- ── (1) app_user ADD COLUMN phone ─────────────────────────────────────────────
-- Nullable free-text field. No format enforcement. Existing rows get NULL.
-- All existing INSERT statements that omit this column continue to succeed.

ALTER TABLE "app_user" ADD COLUMN "phone" text;


-- ── (2) app_user ADD COLUMN status ────────────────────────────────────────────
-- ROSTER FLAG only — NOT an auth gate in this slice.
-- NOT NULL DEFAULT 'active': existing rows are silently back-filled to 'active'.
-- All existing INSERT statements that omit this column continue to succeed.
--
-- !! 'inactive' does NOT block login in this slice. !!
-- Login does not read the status column. Wiring inactive → login-refusal is
-- deferred to a future auth slice. [VERIFY-6-D]

ALTER TABLE "app_user" ADD COLUMN "status" text NOT NULL DEFAULT 'active';


-- ── (3) app_user_status_check ─────────────────────────────────────────────────
-- text + CHECK (not a pg enum) for additive/reversible two-value domain.
-- Rejects any value that is not 'active' or 'inactive'.

ALTER TABLE "app_user"
  ADD CONSTRAINT "app_user_status_check"
  CHECK ("status" IN ('active', 'inactive'));


-- ── (4) CREATE TABLE member_tag ───────────────────────────────────────────────
--
-- Free-text operator labels attached to a member (app_user) within an org.
-- Tags carry NO regulatory, currency, medical, eligibility, or FAA meaning.
-- [VERIFY-6-A] (HARD COMPLIANCE LINE): member_tag.tag is a FREE-TEXT operator
-- label ONLY. Eligibility ENFORCEMENT is NOT in this slice.
--
-- NO updated_at column: tags are add/remove only. An unwanted tag is deleted
-- and a corrected one is re-added (not mutated).
--
-- Composite FKs (all hand-written; Drizzle cannot express multi-column FKs):
--
--   FK (org_id) → org(id) ON DELETE CASCADE  [member_tag_org_id_fk]
--     Tenant spine — deleting an org cascades to its member_tag rows.
--
--   Composite FK (user_id, org_id) → app_user(id, org_id) ON DELETE CASCADE
--     [member_tag_user_org_fk]
--     Tags are disposable labels, not audited records — CASCADE is correct.
--     Prevents cross-org user references.
--     Targets app_user_id_org_id_unique established in migration 0000.
--
--   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
--     [member_tag_created_by_org_fk]
--     Preserves attribution: prevents deleting the creating user while their
--     authorship record exists.
--     Targets app_user_id_org_id_unique established in migration 0000.
--
-- CHECKs:
--   member_tag_tag_nonempty_check: char_length(btrim(tag)) > 0
--     Prevents blank-only or empty tags; UI trims before sending.
--
-- UNIQUEs:
--   member_tag_user_id_tag_unique UNIQUE (user_id, tag)
--     Case-sensitive exact match; same tag may exist on different members.
--
--   member_tag_id_org_id_unique UNIQUE (id, org_id)
--     Composite candidate key — forward-compat for future composite FKs,
--     consistent with all other tenant tables.

CREATE TABLE "member_tag" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"      uuid NOT NULL,
  "user_id"     uuid NOT NULL,
  "tag"         text NOT NULL,
  "created_by"  uuid NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "member_tag_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: tag must reference a user in the same org.
  -- ON DELETE CASCADE: tags are disposable labels, not audited records.
  -- Targets app_user_id_org_id_unique from migration 0000.
  CONSTRAINT "member_tag_user_org_fk"
    FOREIGN KEY ("user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE CASCADE,

  -- Composite FK: creator must be a user in the same org.
  -- ON DELETE RESTRICT: preserves attribution.
  -- Targets app_user_id_org_id_unique from migration 0000.
  CONSTRAINT "member_tag_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Tag must not be empty (or blank-only). UI trims before sending.
  CONSTRAINT "member_tag_tag_nonempty_check" CHECK (
    char_length(btrim("tag")) > 0
  ),

  -- Same tag cannot appear twice for one member (case-sensitive).
  CONSTRAINT "member_tag_user_id_tag_unique"
    UNIQUE ("user_id", "tag"),

  -- Composite candidate key — forward-compat for future composite FKs.
  -- Consistent with all other tenant tables.
  CONSTRAINT "member_tag_id_org_id_unique"
    UNIQUE ("id", "org_id")
);


-- ── (5) Index ─────────────────────────────────────────────────────────────────
-- Covers: listTags for a member — WHERE org_id = $1 AND user_id = $2

CREATE INDEX "member_tag_org_user_idx"
  ON "member_tag" ("org_id", "user_id");


-- ── (6) ENABLE + FORCE RLS on member_tag ──────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "member_tag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "member_tag" FORCE  ROW LEVEL SECURITY;


-- ── (7) RLS policies ──────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows (fail-closed)
--
-- Every policy is named explicitly for auditability.
-- 4 policies: SELECT, INSERT, UPDATE, DELETE.
-- member_tag is add/remove only (no sanctioned UPDATE code path) but the
-- RLS UPDATE policy is required to prevent unguarded mutations.

CREATE POLICY "member_tag_select"
  ON "member_tag"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "member_tag_insert"
  ON "member_tag"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "member_tag_update"
  ON "member_tag"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "member_tag_delete"
  ON "member_tag"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (8) GRANT to aeroops_app ──────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "member_tag" TO aeroops_app;
