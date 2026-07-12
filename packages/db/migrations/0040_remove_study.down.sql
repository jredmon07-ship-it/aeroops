-- 0040_remove_study.down.sql — re-creates the AeroStudy tables by
-- replaying migration 0035's full up content verbatim (data NOT restored).

-- ============================================================
-- AeroOps — Slice STUDY-1: AeroStudy integration server seam
-- Migration: 0035_study_grant.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0034_block_time.sql must
--               already be applied.
--
-- CONTEXT (docs: the AeroStudy integration design doc §4):
-- a flight school running AeroOps provisions AeroStudy (an offline FAA
-- knowledge-test trainer) to its members. Two tenant-scoped tables:
--
--   study_grant — "this school grants this member this AeroStudy access."
--     scope ∈ { 'all_access', <cert code like 'PAR'> }. Written by
--     owner/manager (web, later slice); READ by the member over the EXISTING
--     mobile-token guard (GET /api/mobile/v1/study/entitlements — a
--     self-scoped read, session.userId only). Revocation is a soft flip of
--     revoked_at (mirrors mobile_session.revoked_at), never a DELETE — the
--     grant history stays visible to the org.
--
--   study_progress — a compact per-(org,user,cert) READ MODEL of the
--     member's knowledge-test readiness, upserted by the mobile app for the
--     signed-in member (POST /api/mobile/v1/study/progress, self-scoped).
--     NO raw answer logs, NO PII beyond the app_user already in the org —
--     only readiness %, questions-logged count, and a last-studied instant.
--     Later read by cfi/manager/owner for the CFI dashboard (forward seam).
--
-- COMPLIANCE posture: study readiness is STUDENT-ENTERED STUDY-APP DATA, not
-- an FAA knowledge-test result, endorsement, or Part 61/141 determination.
-- NO money moves here (school-tier packaging is a later, founder-gated
-- phase); no Stripe, no card/bank data.
--
-- Key guarantees:
--   (1) Tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS + the standard
--       4-policy (mutable) SELECT/INSERT/UPDATE/DELETE pattern on BOTH
--       tables (mirrors mobile_session 0033, WITHOUT its platform-admin
--       SELECT branch — every study read/write happens inside withOrgContext
--       using the org_id from the verified mobile token; no pre-org-context
--       lookup exists on this surface).
--   (2) Partial UNIQUE index study_grant(org_id, user_id, scope) WHERE
--       revoked_at IS NULL — at most ONE ACTIVE grant per (member, scope);
--       revoked history rows may repeat (re-grant after revoke works).
--       Same partial-unique mechanism as dispatch_ticket's one-open-ticket
--       backstop (migration 0005).
--   (3) UNIQUE study_progress(org_id, user_id, cert_code) — the upsert
--       conflict target (ON CONFLICT … DO UPDATE); exactly one readiness
--       row per member per cert.
--   (4) Composite FKs (hand-written; Drizzle cannot express multi-column
--       FKs), mirroring membership's composite-FK convention exactly:
--         (org_id) → org(id) ON DELETE CASCADE.
--         (user_id, org_id) → app_user(id, org_id) ON DELETE CASCADE — a
--           grant/progress row has no meaning once its member is gone
--           (access state + a derived read model, NOT a durable
--           billing/records artifact — mirrors mobile_session_user_org_fk,
--           not dues_schedule's RESTRICT).
--         study_grant (granted_by, org_id) → app_user(id, org_id)
--           ON DELETE RESTRICT — attribution on who granted access is
--           preserved (mirrors block_package_created_by_org_fk).
--   (5) UNIQUE (id, org_id) composite candidate key on both tables —
--       consistent with all other tenant tables.
--   (6) scope / cert_code format CHECKs: scope is 'all_access' or an FAA
--       cert code (uppercase alphanumeric, 2–10 chars, e.g. 'PAR', 'IRA');
--       cert_code is the same code format ('all_access' is NOT a valid
--       cert_code — progress is always per-cert). Client-side these map
--       1:1 onto AeroStudy product IDs (aerostudy.cert.<code> /
--       aerostudy.allaccess.*).
--   (7) readiness_percent is numeric(5,4) CHECK [0..1] — a FRACTION, not
--       money; questions_logged is integer CHECK >= 0.
--   (8) STRICTLY ADDITIVE — no existing table/column/constraint is touched.
--       The FROZEN dispatch gate, gatedCreateOccurrence, and every other
--       engine are untouched. NO write/dispatch/money surface beyond the
--       member's OWN readiness upsert.
--
-- ORDER within this file:
--   (1) CREATE TABLE study_grant (FKs + CHECKs + UNIQUEs)
--   (2) CREATE TABLE study_progress (FKs + CHECKs + UNIQUEs)
--   (3) Indexes (incl. the partial UNIQUE active-grant backstop)
--   (4) ENABLE + FORCE RLS (2 tables)
--   (5) RLS policies (standard 4-policy, both tables)
--   (6) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE study_grant ─────────────────────────────────────────────────────

CREATE TABLE "study_grant" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"     uuid NOT NULL,
  "user_id"    uuid NOT NULL,
  "scope"      text NOT NULL,
  "granted_by" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,

  -- Tenant spine FK.
  CONSTRAINT "study_grant_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the granted member must be a user in the same org.
  -- ON DELETE CASCADE: a grant has no meaning once its member is gone
  -- (mirrors membership_user_org_fk / mobile_session_user_org_fk).
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "study_grant_user_org_fk"
    FOREIGN KEY ("user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE CASCADE,

  -- Composite FK: the granting staff member must be in the same org.
  -- ON DELETE RESTRICT: attribution is preserved (mirrors
  -- block_package_created_by_org_fk).
  CONSTRAINT "study_grant_granted_by_org_fk"
    FOREIGN KEY ("granted_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "study_grant_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- scope is 'all_access' or an FAA knowledge-test cert code (uppercase
  -- alphanumeric, 2–10 chars, starts with a letter — e.g. 'PAR', 'IRA').
  -- Must match STUDY_CERT_CODE_PATTERN in packages/api/src/study/internal.ts.
  CONSTRAINT "study_grant_scope_format_check" CHECK (
    "scope" = 'all_access' OR "scope" ~ '^[A-Z][A-Z0-9]{1,9}$'
  )
);


-- ── (2) TABLE study_progress ──────────────────────────────────────────────────
--
-- Compact per-(org, user, cert) readiness READ MODEL. Upserted (INSERT … ON
-- CONFLICT DO UPDATE) by the mobile app for the signed-in member ONLY —
-- always the LATEST summary, never a log. See the file header for the
-- data-minimization posture.

CREATE TABLE "study_progress" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"            uuid NOT NULL,
  "user_id"           uuid NOT NULL,
  "cert_code"         text NOT NULL,
  "readiness_percent" numeric(5, 4) NOT NULL,
  "questions_logged"  integer NOT NULL,
  "last_studied_at"   timestamptz NOT NULL,
  "updated_at"        timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "study_progress_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the member must be a user in the same org.
  -- ON DELETE CASCADE: a derived read model has no meaning once its member
  -- is gone (mirrors membership_user_org_fk).
  CONSTRAINT "study_progress_user_org_fk"
    FOREIGN KEY ("user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE CASCADE,

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "study_progress_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- The upsert conflict target: exactly one readiness row per member per
  -- cert. ON CONFLICT ("org_id", "user_id", "cert_code") DO UPDATE.
  CONSTRAINT "study_progress_org_user_cert_unique"
    UNIQUE ("org_id", "user_id", "cert_code"),

  -- cert_code is ALWAYS a per-cert code — 'all_access' is a grant scope,
  -- never a progress key. Same code format as study_grant_scope_format_check.
  CONSTRAINT "study_progress_cert_code_format_check" CHECK (
    "cert_code" ~ '^[A-Z][A-Z0-9]{1,9}$'
  ),

  -- readiness_percent is a FRACTION in [0, 1] (client sends 0..1, not 0..100).
  CONSTRAINT "study_progress_readiness_range_check" CHECK (
    "readiness_percent" >= 0 AND "readiness_percent" <= 1
  ),

  -- questions_logged is a COUNT — never negative.
  CONSTRAINT "study_progress_questions_nonnegative_check" CHECK (
    "questions_logged" >= 0
  )
);


-- ── (3) Indexes ───────────────────────────────────────────────────────────────

-- Partial UNIQUE backstop: at most ONE ACTIVE (unrevoked) grant per
-- (org, member, scope). Revoked rows may repeat — revoke then re-grant is a
-- normal lifecycle. Also the covering index for the mobile entitlements
-- read (WHERE user_id = $1 AND revoked_at IS NULL, org-scoped by RLS).
-- Same partial-unique mechanism as dispatch_ticket_one_open_per_aircraft
-- (migration 0005).
CREATE UNIQUE INDEX "study_grant_org_user_scope_active_unique"
  ON "study_grant" ("org_id", "user_id", "scope")
  WHERE "revoked_at" IS NULL;

-- Full-history per-member grant listing (admin surface, later slice) —
-- covers revoked rows too (mirrors mobile_session_org_user_idx).
CREATE INDEX "study_grant_org_user_idx"
  ON "study_grant" ("org_id", "user_id");

-- study_progress needs no extra index: study_progress_org_user_cert_unique
-- (org_id leading) covers both the member self-read and the future org-wide
-- CFI dashboard scan.


-- ── (4) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "study_grant"    ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "study_grant"    FORCE   ROW LEVEL SECURITY;

ALTER TABLE "study_progress" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "study_progress" FORCE   ROW LEVEL SECURITY;


-- ── (5) RLS policies ──────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)
--
-- Standard 4-policy (mutable) pattern on both tables — NO platform-admin
-- branch: every study read/write already runs inside withOrgContext with the
-- org_id from the verified mobile token (unlike resolveMobileSessionByHash,
-- nothing here must look up a row before org context exists).

-- ── study_grant policies ──────────────────────────────────────────────────────

CREATE POLICY "study_grant_select"
  ON "study_grant"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "study_grant_insert"
  ON "study_grant"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "study_grant_update"
  ON "study_grant"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "study_grant_delete"
  ON "study_grant"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── study_progress policies ───────────────────────────────────────────────────

CREATE POLICY "study_progress_select"
  ON "study_progress"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "study_progress_insert"
  ON "study_progress"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "study_progress_update"
  ON "study_progress"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "study_progress_delete"
  ON "study_progress"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (6) GRANT to aeroops_app ──────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "study_grant"    TO aeroops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "study_progress" TO aeroops_app;
