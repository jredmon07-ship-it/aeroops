-- ============================================================
-- AeroOps — DOWN migration for 0048_avatars.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Reverses 0048 in exact reverse order. Dropping the column deletes stored
-- avatars (they are optional display images only — no records/audit meaning);
-- application code degrades to initials-only avatars.
-- ============================================================

ALTER TABLE "app_user"
  DROP CONSTRAINT "app_user_avatar_data_check";

ALTER TABLE "app_user"
  DROP COLUMN "avatar_data";
