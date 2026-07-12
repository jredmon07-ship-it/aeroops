-- ============================================================
-- AeroOps — Down migration for 0037_logbook_annotation.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes ALL
-- logbook_annotation records (every pilot-entered night/instrument/
-- cross-country/remarks annotation, for every org) AND drops the
-- resource.category / resource.aircraft_class identity columns (their
-- operator-entered values are lost). It does NOT touch dispatch_ticket or
-- any other table.
--
-- Reverses (in order — reverse of up):
--   (6) DROP resource.category / resource.aircraft_class columns
--   (5) REVOKE bookkeeping (no-op: dropping the table removes grants)
--   (4) DROP RLS policies
--   (3) DISABLE + un-FORCE RLS
--   (2) DROP index
--   (1) DROP TABLE logbook_annotation
-- ============================================================


-- ── (6) Drop the additive resource columns ────────────────────────────────────

ALTER TABLE "resource" DROP COLUMN IF EXISTS "aircraft_class";
ALTER TABLE "resource" DROP COLUMN IF EXISTS "category";


-- ── (4) Drop RLS policies ────────────────────────────────────────────────────

DROP POLICY IF EXISTS "logbook_annotation_insert" ON "logbook_annotation";
DROP POLICY IF EXISTS "logbook_annotation_select" ON "logbook_annotation";


-- ── (3) Disable RLS ──────────────────────────────────────────────────────────

ALTER TABLE "logbook_annotation" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "logbook_annotation" DISABLE ROW LEVEL SECURITY;


-- ── (2) Drop index ───────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "logbook_annotation_org_ticket_created_idx";


-- ── (1) DROP TABLE logbook_annotation ────────────────────────────────────────

DROP TABLE IF EXISTS "logbook_annotation";
