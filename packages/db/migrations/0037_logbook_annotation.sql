-- ============================================================
-- AeroOps — Slice P2-LOG2: Pilot-logbook depth — flight-condition
-- annotations + aircraft category/class
-- Migration: 0037_logbook_annotation.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0036_member_message.sql must
--               already be applied.
--
-- CONTEXT: the pilot logbook (Slice P2) is a derived, read-only projection
-- of CLOSED dispatch tickets. Pilots also want per-flight night / instrument
-- (IMC) / cross-country time + free-text remarks, and each row should show
-- the aircraft's category/class. The dispatch close path is FROZEN
-- (ADR-0007) — so annotations live in a NEW append-only side table, and the
-- category/class identity fields are ADDITIVE nullable columns on resource.
--
--   logbook_annotation — APPEND-ONLY per-ticket pilot/operator-entered
--     flight-condition annotation (mirrors dispatch_ticket_correction's
--     latest-wins pattern from migration 0018 exactly: SELECT + INSERT RLS
--     policies ONLY). The EFFECTIVE annotation for a ticket is the latest
--     row (ORDER BY created_at DESC LIMIT 1 per dispatch_ticket_id); a
--     mistaken annotation is superseded by a NEW row, never edited.
--
-- COMPLIANCE HARD LINE: night/instrument/cross-country hours and remarks
-- are PILOT/OPERATOR-ENTERED DATA — this is NOT an FAA logbook of record,
-- NOT a certified §61.51 entry, and AeroOps makes NO computed currency /
-- recency / experience determination (§61.51 / §61.57) from these values.
-- resource.category / resource.aircraft_class are FREE TEXT operator-entered
-- identity fields (e.g. 'Airplane' / 'ASEL') — NOT an enum, NOT a
-- certification or type-rating determination.
--
-- Key guarantees:
--   (1) Tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS + the standard
--       current_org_id GUC predicate.
--   (2) APPEND-ONLY: SELECT + INSERT policies only; GRANT SELECT, INSERT;
--       REVOKE UPDATE, DELETE as the belt-and-suspenders backstop (mirrors
--       dispatch_ticket_correction / audit_log).
--   (3) Composite FKs (hand-written; Drizzle cannot express multi-column FKs):
--         (org_id) → org(id) ON DELETE CASCADE.
--         (dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id)
--           ON DELETE RESTRICT — an annotated ticket cannot be hard-deleted
--           (records integrity). Targets dispatch_ticket_id_org_id_unique (0005).
--         (pilot_user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT —
--           the annotated pilot must be in the same org (cross-org guard).
--         (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT —
--           authoring identity persists with the immutable record.
--   (4) UNIQUE (id, org_id) composite candidate key — consistent with all
--       other tenant tables.
--   (5) CHECKs: each hours column NULL or in [0, 99.9] (numeric(5,1));
--       at least one of the four annotation fields present (a fully-empty
--       annotation row is a no-op and is rejected — mirrors
--       correction_at_least_one_meter_check); remarks NULL or non-empty
--       (trimmed) and <= 2000 chars.
--   (6) STRICTLY ADDITIVE — the FROZEN dispatch tables/paths are untouched;
--       resource only GAINS two nullable text columns. NO money.
--
-- ORDER within this file:
--   (1) CREATE TABLE logbook_annotation (FKs + CHECKs)
--   (2) Index
--   (3) ENABLE + FORCE RLS
--   (4) RLS policies (SELECT + INSERT only — append-only)
--   (5) GRANT to aeroops_app
--   (6) ALTER TABLE resource ADD COLUMN category / aircraft_class
-- ============================================================


-- ── (1) TABLE logbook_annotation ──────────────────────────────────────────────

CREATE TABLE "logbook_annotation" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"                uuid NOT NULL,
  "dispatch_ticket_id"    uuid NOT NULL,
  "pilot_user_id"         uuid NOT NULL,
  "night_hours"           numeric(5,1),
  "instrument_hours"      numeric(5,1),
  "cross_country_hours"   numeric(5,1),
  "remarks"               text,
  "created_by"            uuid NOT NULL,
  "created_at"            timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "logbook_annotation_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: annotation must reference a ticket in the same org.
  -- ON DELETE RESTRICT: prevents hard-deleting a ticket with annotations.
  -- Targets dispatch_ticket_id_org_id_unique established in migration 0005.
  CONSTRAINT "logbook_annotation_ticket_org_fk"
    FOREIGN KEY ("dispatch_ticket_id", "org_id")
    REFERENCES "dispatch_ticket"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: the annotated pilot must be a user in the same org.
  -- Targets app_user_id_org_id_unique established in migration 0000.
  CONSTRAINT "logbook_annotation_pilot_org_fk"
    FOREIGN KEY ("pilot_user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: author must be a user in the same org; authoring identity
  -- persists with the immutable record (mirrors 0018's created_by FK).
  CONSTRAINT "logbook_annotation_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all tenant tables.
  CONSTRAINT "logbook_annotation_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Hours bounds: NULL or [0, 99.9]. numeric(5,1) caps at 9999.9 — the CHECK
  -- narrows to a sane single-flight range in tenths.
  CONSTRAINT "annotation_night_hours_range_check" CHECK (
    "night_hours" IS NULL OR ("night_hours" >= 0 AND "night_hours" <= 99.9)
  ),
  CONSTRAINT "annotation_instrument_hours_range_check" CHECK (
    "instrument_hours" IS NULL OR ("instrument_hours" >= 0 AND "instrument_hours" <= 99.9)
  ),
  CONSTRAINT "annotation_cross_country_hours_range_check" CHECK (
    "cross_country_hours" IS NULL OR ("cross_country_hours" >= 0 AND "cross_country_hours" <= 99.9)
  ),

  -- A fully-empty annotation is a no-op and is rejected (mirrors
  -- correction_at_least_one_meter_check in migration 0018).
  CONSTRAINT "annotation_at_least_one_field_check" CHECK (
    "night_hours" IS NOT NULL OR
    "instrument_hours" IS NOT NULL OR
    "cross_country_hours" IS NOT NULL OR
    "remarks" IS NOT NULL
  ),

  -- Remarks: NULL, or non-empty (trimmed) with a sane length cap.
  CONSTRAINT "annotation_remarks_check" CHECK (
    "remarks" IS NULL OR
    (char_length(btrim("remarks")) > 0 AND char_length("remarks") <= 2000)
  )
);


-- ── (2) Index ─────────────────────────────────────────────────────────────────
-- Covers: "latest annotation per ticket" — the effective-annotation query
-- (mirrors correction_org_ticket_created_idx from migration 0018).
-- e.g. SELECT * FROM logbook_annotation
--        WHERE org_id = $1 AND dispatch_ticket_id = $2
--        ORDER BY created_at DESC LIMIT 1

CREATE INDEX "logbook_annotation_org_ticket_created_idx"
  ON "logbook_annotation" ("org_id", "dispatch_ticket_id", "created_at" DESC);


-- ── (3) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "logbook_annotation" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "logbook_annotation" FORCE   ROW LEVEL SECURITY;


-- ── (4) RLS policies — APPEND-ONLY (SELECT + INSERT only) ─────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)
--
-- APPEND-ONLY posture (mirrors dispatch_ticket_correction exactly): no UPDATE
-- or DELETE policy. With FORCE ROW LEVEL SECURITY, the absence of a
-- permissive policy blocks those operations for ALL roles, including the
-- table owner — an annotation row is immutable once inserted; the latest row
-- per ticket wins.

CREATE POLICY "logbook_annotation_select"
  ON "logbook_annotation"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "logbook_annotation_insert"
  ON "logbook_annotation"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (5) GRANT to aeroops_app — SELECT + INSERT only ───────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed. REVOKE UPDATE, DELETE is the belt-and-suspenders backstop
-- (mirrors the dispatch_ticket_correction / audit_log pattern).

GRANT SELECT, INSERT ON "logbook_annotation" TO aeroops_app;
REVOKE UPDATE, DELETE ON "logbook_annotation" FROM aeroops_app;


-- ── (6) Additive resource identity columns — category / aircraft_class ────────
-- FREE TEXT, operator-entered (e.g. 'Airplane' / 'ASEL'). NOT an enum, NOT a
-- certification/type-rating determination — display data for the logbook and
-- fleet identity surfaces. Nullable so existing inserts continue to succeed;
-- resource_kind_shape_check is NOT widened (same posture as the Slice 5
-- identity columns in migration 0007). Table-level GRANTs on resource already
-- cover new columns — no GRANT change needed.

ALTER TABLE "resource" ADD COLUMN "category"        text;
ALTER TABLE "resource" ADD COLUMN "aircraft_class"  text;
