-- ============================================================
-- AeroOps — Slice P1.7: Flight Circle data importer
-- Migration: 0027_data_import.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0026_notifications.sql
--               must already be applied.
--
-- Implements P1.7: operator-provided CSV import of members + aircraft roster
-- data (the fast-onboarding path — "migrate off Flight Circle" in an
-- afternoon). Ingests CSV files the operator downloads from their existing
-- provider's export/reports screen and stages every row for review BEFORE
-- any real app_user/resource record is created. NO ledger/financial-history
-- import in this slice — see docs/specs/slice-p1-fc-import.md for the
-- deferred list.
--
--   import_batch — one row per uploaded CSV file (kind=members|aircraft),
--     tracking status (pending → previewed → committed|failed) + row counts +
--     the CONFIRMED column mapping (jsonb) used at preview time. STANDARD
--     4-policy mutable RLS (mirrors migration 0024's stripe_payment_method/
--     autopay_setting) — status + counts are updated as the batch progresses
--     through preview → commit.
--   import_row — one row per parsed CSV line, staged at preview time and
--     updated in place as each row is resolved at commit time
--     (pending → imported|skipped|error, target_id set on success). NEVER
--     DELETEd (no DELETE policy/grant — the append/update-only posture), but
--     UNLIKE the audit_log/ledger_entry/dispatch_ticket_correction family this
--     table DOES carry an UPDATE policy: mapped_status/target_id/error_detail
--     are mutated in place as commitImport resolves each staged row (a bad
--     row updates to 'error' and the loop continues — see commit-import.ts).
--     This is a deliberate, narrower posture than the fully-immutable
--     append-only tables: raw_data + row_index + created_at are effectively
--     write-once in practice (the command layer never touches them after
--     INSERT), but the schema does not need a structural CHECK to prove it
--     because no compliance/money guarantee rides on import_row's immutability
--     (it is an operator-facing staging/audit convenience, not a financial or
--     regulatory record).
--
-- Key guarantees:
--   (1) Both tables are tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS +
--       the standard current_org_id GUC predicate.
--   (2) import_batch.source is constrained to 'flight_circle' only (CHECK) —
--       a forward seam for other providers without a schema change beyond
--       widening this CHECK.
--   (3) import_batch.kind constrained to 'members'|'aircraft' — NO ledger/
--       financial-history kind exists in this migration; a Sales-Transactions
--       -shaped CSV is detected in application code (looksLikeSalesTransactions
--       Export, @aeroops/core) and marked out-of-scope-for-commit via
--       import_batch.error_detail, never given its own kind/table.
--   (4) import_row.mapped_status constrained to 'pending'|'imported'|
--       'skipped'|'error'.
--   (5) Composite FKs are all hand-written (Drizzle cannot express multi-col
--       FKs). Named constraints follow the {table}_{fk_col}_org_fk convention.
--   (6) import_batch.created_by: composite FK (created_by, org_id) →
--       app_user(id, org_id) ON DELETE RESTRICT — preserves import-history
--       attribution (mirrors rate_schedule.created_by, migration 0019).
--   (7) import_row.import_batch_id: composite FK (import_batch_id, org_id) →
--       import_batch(id, org_id) ON DELETE CASCADE — staging rows have no
--       meaning once their batch is gone (no delete command exists on
--       import_batch in this slice; CASCADE is a forward-looking backstop,
--       same reasoning as notification_pref → app_user CASCADE, migration 0026).
--   (8) UNIQUE (import_batch_id, row_index) on import_row — one staged row per
--       CSV line per batch; also the natural re-preview idempotency key.
--   (9) UNIQUE (id, org_id) on both tables — composite candidate key,
--       consistent with every other tenant table.
--  (10) target_id (import_row) is a BARE uuid with NO FK — it may point at
--       either app_user.id (members) or resource.id (aircraft) depending on
--       the parent batch's kind, so a single-target FK is not expressible;
--       the command layer is the source of truth for what target_id means
--       (mirrors booking_request's deliberate no-FK posture for
--       provider-ambiguous ids... actually distinct reason here: polymorphic
--       target, not an anon-write posture. See getImportBatch for how the
--       API resolves target_id back to a display row).
--  (11) STRICTLY ADDITIVE — no existing tables/columns/constraints modified.
--       Only the two new tables are created.
--  (12) NO Stripe/card/bank data; NO money column; NO ledger/financial-history
--       import in this migration or the commands built on it. Members import
--       as ROSTER ENTRIES ONLY via the EXISTING addMember path (no
--       auth_credential — same as Slice 6.2's addMember). Aircraft import via
--       the EXISTING createResource + updateAircraft paths — no bespoke
--       INSERT into app_user or resource anywhere in this slice's commands.
--
-- ORDER within this file:
--   (1) CREATE TABLE import_batch (FKs + CHECKs)
--   (2) CREATE TABLE import_row (FKs + CHECK + UNIQUE)
--   (3) Indexes
--   (4) ENABLE + FORCE RLS (2 tables)
--   (5) RLS policies
--   (6) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE import_batch ────────────────────────────────────────────────────
--
-- One row per uploaded CSV file. Written by previewImport (INSERT, status=
-- 'previewed') and updated by commitImport (status → 'committed'|'failed',
-- imported_count/skipped_count set).
--
-- Composite FKs (hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT:
--     The staff member who uploaded the file. RESTRICT preserves import-
--     history attribution (mirrors rate_schedule.created_by, migration 0019).
--     Targets app_user_id_org_id_unique (migration 0000).

CREATE TABLE "import_batch" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"          uuid NOT NULL,
  "source"          text NOT NULL DEFAULT 'flight_circle',
  "kind"            text NOT NULL,
  "status"          text NOT NULL DEFAULT 'pending',
  "filename"        text NOT NULL,
  "row_count"       integer NOT NULL DEFAULT 0,
  "imported_count"  integer NOT NULL DEFAULT 0,
  "skipped_count"   integer NOT NULL DEFAULT 0,
  "error_detail"    text,
  -- The CONFIRMED column mapping (field name -> CSV header name) used at
  -- preview time. commitImport re-derives each row's normalized candidate
  -- from import_row.raw_data using THIS mapping (never re-asked of the
  -- operator, never re-guessed) so preview and commit can never disagree
  -- about which CSV column means what.
  "mapping"         jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_by"      uuid NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "import_batch_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the uploader must be a member of the same org.
  -- ON DELETE RESTRICT: preserves import-history attribution.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "import_batch_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "import_batch_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Forward seam for other providers — widen when a second source ships.
  CONSTRAINT "import_batch_source_check" CHECK (
    "source" IN ('flight_circle')
  ),

  CONSTRAINT "import_batch_kind_check" CHECK (
    "kind" IN ('members', 'aircraft')
  ),

  CONSTRAINT "import_batch_status_check" CHECK (
    "status" IN ('pending', 'previewed', 'committed', 'failed')
  ),

  CONSTRAINT "import_batch_counts_nonneg_check" CHECK (
    "row_count" >= 0 AND "imported_count" >= 0 AND "skipped_count" >= 0
  ),

  CONSTRAINT "import_batch_filename_nonempty_check" CHECK (
    char_length(btrim("filename")) > 0
  )
);


-- ── (2) TABLE import_row ────────────────────────────────────────────────────────
--
-- One row per parsed CSV line, staged by previewImport (INSERT, mapped_status
-- computed pending/skipped/error) and updated in place by commitImport
-- (pending → imported/skipped/error, target_id set on success). See the
-- file-header note on why this table carries an UPDATE policy (unlike the
-- fully-immutable append-only family).
--
-- Composite FKs (hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   Composite FK (import_batch_id, org_id) → import_batch(id, org_id)
--     ON DELETE CASCADE:
--     A staging row has no meaning once its batch is gone.

CREATE TABLE "import_row" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"           uuid NOT NULL,
  "import_batch_id"  uuid NOT NULL,
  "row_index"        integer NOT NULL,
  "raw_data"         jsonb NOT NULL,
  "mapped_status"    text NOT NULL DEFAULT 'pending',
  -- target_id: the created app_user.id (members) or resource.id (aircraft).
  -- Deliberately NO FK — polymorphic target depending on the parent batch's
  -- kind; see file-header note (10).
  "target_id"        uuid,
  "error_detail"     text,
  "created_at"       timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "import_row_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the row's batch must be in the same org. CASCADE — a
  -- staging row has no meaning once its batch is gone.
  CONSTRAINT "import_row_batch_org_fk"
    FOREIGN KEY ("import_batch_id", "org_id")
    REFERENCES "import_batch"("id", "org_id") ON DELETE CASCADE,

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "import_row_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- One staged row per CSV line per batch — also the natural re-preview key.
  CONSTRAINT "import_row_batch_rowindex_unique"
    UNIQUE ("import_batch_id", "row_index"),

  CONSTRAINT "import_row_mapped_status_check" CHECK (
    "mapped_status" IN ('pending', 'imported', 'skipped', 'error')
  ),

  CONSTRAINT "import_row_row_index_nonneg_check" CHECK (
    "row_index" >= 0
  )
);


-- ── (3) Indexes ───────────────────────────────────────────────────────────────

-- import_batch: listImportBatches history reads (most-recent-first).
CREATE INDEX "import_batch_org_created_idx"
  ON "import_batch" ("org_id", "created_at" DESC);

-- import_row: getImportBatch per-batch row reads, ordered by row_index.
CREATE INDEX "import_row_org_batch_idx"
  ON "import_row" ("org_id", "import_batch_id", "row_index");

-- import_row: commitImport's "fetch all pending rows for this batch" scan.
CREATE INDEX "import_row_org_batch_status_idx"
  ON "import_row" ("org_id", "import_batch_id", "mapped_status");


-- ── (4) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "import_batch" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "import_batch" FORCE   ROW LEVEL SECURITY;

ALTER TABLE "import_row"   ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "import_row"   FORCE   ROW LEVEL SECURITY;


-- ── (5) RLS policies ──────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)

-- ── import_batch policies (standard 4-policy pattern, mirrors migration 0024) ──

CREATE POLICY "import_batch_select"
  ON "import_batch"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "import_batch_insert"
  ON "import_batch"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "import_batch_update"
  ON "import_batch"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "import_batch_delete"
  ON "import_batch"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── import_row policies — SELECT + INSERT + UPDATE, NO DELETE ─────────────────
-- See file-header note: mapped_status/target_id/error_detail are updated in
-- place by commitImport. NO DELETE policy exists — rows are never removed
-- (belt-and-suspenders REVOKE DELETE below backs this up structurally).

CREATE POLICY "import_row_select"
  ON "import_row"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "import_row_insert"
  ON "import_row"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "import_row_update"
  ON "import_row"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (6) GRANT to aeroops_app ───────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "import_batch" TO aeroops_app;

GRANT SELECT, INSERT, UPDATE ON "import_row" TO aeroops_app;
REVOKE DELETE ON "import_row" FROM aeroops_app;
