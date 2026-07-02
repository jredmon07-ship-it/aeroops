-- ============================================================
-- AeroOps — Down migration for 0020_demo_reset_state.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently
-- removes the demo reset-on-open throttle bookkeeping table.
-- It does NOT touch any tenant/demo DATA — only the one-row-per-slug
-- last_reset_at ledger used to throttle resets.
--
-- Reverses (in order — reverse of up):
--   (1) DROP TABLE demo_reset_state
-- ============================================================

DROP TABLE IF EXISTS "demo_reset_state";
