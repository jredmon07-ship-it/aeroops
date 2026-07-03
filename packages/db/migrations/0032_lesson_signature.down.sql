-- ============================================================
-- AeroOps — Down migration for 0032_lesson_signature.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Applying this permanently removes ALL
-- lesson_signature records — including tombstone rows that document a past
-- void — for every org. This DESTROYS the compliance-relevant attestation
-- history described in the up migration's [VERIFY-P2-A] header. It does NOT
-- touch lesson_record itself (the composite RESTRICT FK only ever blocked
-- deleting a SIGNED lesson_record while this table existed; dropping this
-- table removes that restriction going forward).
--
-- Reverses (in order — reverse of up):
--   (5) REVOKE/re-GRANT bookkeeping (no-op: GRANT was SELECT,INSERT only and
--       UPDATE,DELETE were already REVOKEd; dropping the table removes grants)
--   (4) DROP RLS policies
--   (3) DISABLE + un-FORCE RLS
--   (2) DROP indexes
--   (1) DROP TABLE lesson_signature
-- ============================================================


-- ── (4) Drop RLS policies ────────────────────────────────────────────────────

DROP POLICY IF EXISTS "lesson_signature_insert" ON "lesson_signature";
DROP POLICY IF EXISTS "lesson_signature_select" ON "lesson_signature";


-- ── (3) Disable RLS ──────────────────────────────────────────────────────────

ALTER TABLE "lesson_signature" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "lesson_signature" DISABLE ROW LEVEL SECURITY;


-- ── (2) Drop indexes ─────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "lesson_signature_org_voids_idx";
DROP INDEX IF EXISTS "lesson_signature_org_record_idx";


-- ── (1) DROP TABLE lesson_signature ─────────────────────────────────────────

DROP TABLE IF EXISTS "lesson_signature";
