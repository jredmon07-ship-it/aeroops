-- ============================================================
-- AeroOps — Down migration for 0027_data_import.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes all
-- staged import batches + rows and the two tables.
--
-- Reverses (in order — reverse of up):
--   (6) REVOKE grants
--   (5) DROP RLS policies
--   (4) DISABLE + un-FORCE RLS
--   (3) DROP indexes
--   (2) DROP TABLE import_row
--   (1) DROP TABLE import_batch
-- ============================================================


-- ── (6) Revoke grants ──────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE ON "import_row"   FROM aeroops_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON "import_batch" FROM aeroops_app;


-- ── (5) Drop RLS policies ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "import_row_update" ON "import_row";
DROP POLICY IF EXISTS "import_row_insert" ON "import_row";
DROP POLICY IF EXISTS "import_row_select" ON "import_row";

DROP POLICY IF EXISTS "import_batch_delete" ON "import_batch";
DROP POLICY IF EXISTS "import_batch_update" ON "import_batch";
DROP POLICY IF EXISTS "import_batch_insert" ON "import_batch";
DROP POLICY IF EXISTS "import_batch_select" ON "import_batch";


-- ── (4) Disable RLS ───────────────────────────────────────────────────────────

ALTER TABLE "import_row"   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "import_row"   DISABLE ROW LEVEL SECURITY;

ALTER TABLE "import_batch" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "import_batch" DISABLE ROW LEVEL SECURITY;


-- ── (3) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "import_row_org_batch_status_idx";
DROP INDEX IF EXISTS "import_row_org_batch_idx";
DROP INDEX IF EXISTS "import_batch_org_created_idx";


-- ── (2) DROP TABLE import_row ────────────────────────────────────────────────

DROP TABLE IF EXISTS "import_row";


-- ── (1) DROP TABLE import_batch ──────────────────────────────────────────────

DROP TABLE IF EXISTS "import_batch";
