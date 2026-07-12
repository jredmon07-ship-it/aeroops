-- ============================================================
-- AeroOps — Down migration for 0043_import_source_myfbo.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. This narrows import_batch.source back to
-- ('flight_circle') ONLY.
--
-- !! PRECONDITION !! This will FAIL if any import_batch row has
-- source IN ('myfbo','other') — narrowing the CHECK cannot validate existing
-- rows that violate it. Before running, either delete/re-source those batches
-- or keep the wider constraint. Query to check first:
--   SELECT count(*) FROM import_batch WHERE source <> 'flight_circle';
--
-- Reverses (in order — reverse of up):
--   (2) DROP the widened CHECK
--   (1) ADD BACK the original single-value CHECK
-- ============================================================

ALTER TABLE "import_batch" DROP CONSTRAINT IF EXISTS "import_batch_source_check";

ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_source_check" CHECK (
  "source" IN ('flight_circle')
);
