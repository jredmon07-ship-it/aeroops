-- ============================================================
-- AeroOps — Colored member tags
-- Migration: 0041_member_tag_color.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0040_remove_study.sql must
--               already be applied.
--
-- CONTEXT: member_tag (migration 0008) carries a FREE-TEXT operator label.
-- Operators asked to color-code tags in the roster + member detail so a
-- category reads at a glance. This adds an OPTIONAL palette-key color to a
-- tag. The color is a display hint ONLY — it changes nothing about what a
-- tag MEANS.
--
-- COMPLIANCE (HARD LINE) [VERIFY-6-A]: member_tag remains a FREE-TEXT operator
-- label. A color is a UI presentation hint — the system still computes NO FAA
-- currency/medical/flight-review/Part-61/141/endorsement/eligibility meaning
-- from a tag OR its color.
--
-- Key guarantees:
--   (1) STRICTLY ADDITIVE — one new NULLABLE column on member_tag. No existing
--       column/constraint/policy/grant is touched. Existing rows keep color
--       NULL (renders as the neutral 'slate' default in the UI).
--   (2) color is constrained to a fixed palette KEY set via a CHECK — the
--       column stores an opaque palette key ('slate' | 'red' | …), never a raw
--       CSS/hex value, so the UI maps a key to a literal class (no dynamic
--       class construction, no injection surface).
--   (3) RLS is unchanged: member_tag already ENABLE+FORCE RLS with SELECT/
--       INSERT/UPDATE/DELETE policies (migration 0008); a new column inherits
--       the table's row-level policies and the existing aeroops_app grants —
--       no new GRANT is required for an ADD COLUMN.
--
-- ORDER within this file:
--   (1) ADD COLUMN member_tag.color (nullable)
--   (2) ADD CHECK constraint (palette key set)
-- ============================================================


-- ── (1) ADD COLUMN ────────────────────────────────────────────────────────────
-- Nullable: existing tags default to no color (UI renders 'slate').

ALTER TABLE "member_tag" ADD COLUMN "color" text;


-- ── (2) CHECK: fixed palette KEY set ──────────────────────────────────────────
-- NULL is allowed (no color). A non-null value must be one of the eight
-- palette keys. Storing an opaque key (not a hex/CSS value) keeps the UI's
-- key→class map the single source of truth and avoids dynamic class
-- construction on the web side.

ALTER TABLE "member_tag" ADD CONSTRAINT "member_tag_color_check" CHECK (
  "color" IS NULL OR "color" IN (
    'slate', 'red', 'amber', 'green', 'sky', 'violet', 'rose', 'teal'
  )
);
