-- ============================================================
-- AeroOps — DOWN migration for 0049_signup_terms_acceptance.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Reverses 0049 in exact reverse order. Dropping the table removes the legal
-- acceptance records; createOrgWithOwner degrades to not recording acceptance
-- (the signup checkbox is still enforced in application validation).
-- ============================================================

REVOKE SELECT, INSERT ON "terms_acceptance" FROM aeroops_app;

DROP POLICY "terms_acceptance_insert" ON "terms_acceptance";
DROP POLICY "terms_acceptance_select" ON "terms_acceptance";

ALTER TABLE "terms_acceptance" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "terms_acceptance" DISABLE ROW LEVEL SECURITY;

DROP INDEX "terms_acceptance_org_user_idx";

DROP TABLE "terms_acceptance";
