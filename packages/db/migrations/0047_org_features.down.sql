-- ============================================================
-- AeroOps — DOWN migration for 0047_org_features.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Reverses 0047 in exact reverse order. Dropping the table returns every org
-- to the ALL-MODULES-ENABLED default (application code treats an absent table
-- as "everything on") — no other data is touched.
-- ============================================================

REVOKE SELECT, INSERT, UPDATE, DELETE ON "org_feature_config" FROM aeroops_app;

DROP POLICY "org_feature_config_delete" ON "org_feature_config";
DROP POLICY "org_feature_config_update" ON "org_feature_config";
DROP POLICY "org_feature_config_insert" ON "org_feature_config";
DROP POLICY "org_feature_config_select" ON "org_feature_config";

ALTER TABLE "org_feature_config" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "org_feature_config" DISABLE ROW LEVEL SECURITY;

DROP TABLE "org_feature_config";
