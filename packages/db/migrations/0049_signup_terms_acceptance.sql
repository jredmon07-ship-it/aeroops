-- ============================================================
-- AeroOps — Self-serve signup: terms/privacy acceptance record
-- Migration: 0049_signup_terms_acceptance.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0048_avatars.sql must already be
--               applied.
--
-- CONTEXT: the self-serve signup flow (createOrgWithOwner) creates a new org +
-- its owner, and the owner clicks to accept the Terms of Service and Privacy
-- Policy at signup. This table is the LEGAL RECORD of that acceptance — who
-- accepted, which document, which version, and when. One row per (org, user,
-- document) accepted.
--
-- Key guarantees:
--   (a) STRICTLY ADDITIVE — one new table. No existing table, column,
--       constraint, index, policy, or grant is modified or dropped.
--   (b) APPEND-ONLY — an acceptance record is never edited or deleted (records
--       integrity: this is evidence). GRANT is SELECT + INSERT only; UPDATE and
--       DELETE are REVOKEd. Re-accepting a new version writes a NEW row.
--   (c) Tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS + the standard
--       select/insert policy pair. The insert happens inside the new org's own
--       org context during signup (never platform-admin).
--   (d) GRACEFUL ABSENCE: until this migration is applied the table does not
--       exist; createOrgWithOwner probes to_regclass('terms_acceptance') and
--       skips the acceptance write when absent (signup still requires the
--       checkbox — the DB row is the durable proof, degraded pre-migration).
--   (e) NO PII beyond user_id + an optional coarse IP string. NO card/bank data.
--
-- ORDER within this file:
--   (1) CREATE TABLE terms_acceptance (FKs + CHECK)
--   (2) Index
--   (3) ENABLE + FORCE RLS
--   (4) RLS policies (select + insert only)
--   (5) GRANT to aeroops_app (SELECT + INSERT only; REVOKE UPDATE, DELETE)
-- ============================================================


-- ── (1) TABLE terms_acceptance ────────────────────────────────────────────────

CREATE TABLE "terms_acceptance" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"        uuid NOT NULL,
  "user_id"       uuid NOT NULL,
  "document"      text NOT NULL,
  "version"       text NOT NULL,
  "accepted_ip"   text,
  "accepted_at"   timestamptz NOT NULL DEFAULT now(),
  "created_at"    timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "terms_acceptance_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the accepting user must be a user in the same org.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "terms_acceptance_user_org_fk"
    FOREIGN KEY ("user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE CASCADE,

  -- Which legal document. Free of any computed meaning — just a label.
  CONSTRAINT "terms_acceptance_document_check" CHECK (
    "document" IN ('terms', 'privacy')
  ),

  CONSTRAINT "terms_acceptance_version_nonempty_check" CHECK (
    char_length(btrim("version")) > 0
  )
);


-- ── (2) Index ─────────────────────────────────────────────────────────────────
-- "who in this org accepted what" lookups.
CREATE INDEX "terms_acceptance_org_user_idx"
  ON "terms_acceptance" ("org_id", "user_id");


-- ── (3) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE.

ALTER TABLE "terms_acceptance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "terms_acceptance" FORCE  ROW LEVEL SECURITY;


-- ── (4) RLS policies (select + insert only — append-only) ─────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   fail-closed on an unset/mismatched GUC (NULL = NULL is false in SQL).
-- No UPDATE or DELETE policy exists: with FORCE RLS, the absence of a permissive
-- policy denies the command outright (defense in depth alongside the REVOKE).

CREATE POLICY "terms_acceptance_select"
  ON "terms_acceptance"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "terms_acceptance_insert"
  ON "terms_acceptance"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (5) GRANT to aeroops_app — SELECT + INSERT only ───────────────────────────
-- Append-only: the explicit REVOKE is belt-and-suspenders beside the missing
-- UPDATE/DELETE policies.

GRANT SELECT, INSERT ON "terms_acceptance" TO aeroops_app;
REVOKE UPDATE, DELETE ON "terms_acceptance" FROM aeroops_app;
