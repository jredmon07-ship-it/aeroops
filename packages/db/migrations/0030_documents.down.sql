-- ============================================================
-- AeroOps — Down migration for 0030_documents.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes all
-- document records (uploaded-file METADATA — filename/category/storage_key
-- pointers) and the table itself. It does NOT delete the underlying objects
-- in external object storage — that is a separate, operator-initiated cleanup
-- against the storage provider (out of scope for this migration).
--
-- Reverses (in order — reverse of up):
--   (5) REVOKE grants
--   (4) DROP RLS policies
--   (3) DISABLE + un-FORCE RLS
--   (2) DROP index
--   (1) DROP TABLE document
-- ============================================================


-- ── (5) Revoke grants ────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON "document" FROM aeroops_app;


-- ── (4) Drop RLS policies ────────────────────────────────────────────────────

DROP POLICY IF EXISTS "document_delete" ON "document";
DROP POLICY IF EXISTS "document_update" ON "document";
DROP POLICY IF EXISTS "document_insert" ON "document";
DROP POLICY IF EXISTS "document_select" ON "document";


-- ── (3) Disable RLS ──────────────────────────────────────────────────────────

ALTER TABLE "document" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "document" DISABLE ROW LEVEL SECURITY;


-- ── (2) Drop index ───────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "document_org_owner_idx";


-- ── (1) DROP TABLE document ──────────────────────────────────────────────────

DROP TABLE IF EXISTS "document";
