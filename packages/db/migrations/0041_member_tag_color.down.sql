-- ============================================================
-- AeroOps — Down migration for 0041_member_tag_color.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this removes the color hint from
-- every member tag, for every org. It does NOT touch the tag text, the tag's
-- membership, audit_log, or any other table.
--
-- Reverses (in order — reverse of up):
--   (2) DROP CHECK constraint
--   (1) DROP COLUMN member_tag.color
-- ============================================================

ALTER TABLE "member_tag" DROP CONSTRAINT IF EXISTS "member_tag_color_check";

ALTER TABLE "member_tag" DROP COLUMN IF EXISTS "color";
