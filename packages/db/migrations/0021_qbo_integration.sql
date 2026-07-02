-- ============================================================
-- AeroOps — Slice QB1: QuickBooks Online integration foundation
-- Migration: 0021_qbo_integration.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0020_demo_reset_state.sql
--               must already be applied.
--
-- Implements Slice QB1: a bookkeeping EXPORT integration to QuickBooks
-- Online. This is NOT a payment processor and NEVER moves money — it
-- pushes existing operator-created invoice RECORDS (Slice B1) into the
-- operator's own QBO company file as a QBO Invoice, one org at a time,
-- self-serve OAuth2-connected, with itemized lines mapped to the
-- operator's own QBO income accounts (per-line-item-kind GL mapping —
-- the explicit competitive wedge vs. lump-sum batch exports).
--
--   qbo_connection      — one OAuth2 connection per org (realm + tokens).
--   qbo_export_log      — append-only push history (invoice/customer).
--   qbo_account_mapping — per-org, per-line-item-kind → QBO Item/account.
--
-- Key guarantees:
--   (1) All three tables are tenant-scoped: org_id NOT NULL + ENABLE+FORCE
--       RLS. qbo_connection + qbo_account_mapping get the standard 4-policy
--       (SELECT/INSERT/UPDATE/DELETE) pattern (mirrors migration 0019).
--       qbo_export_log is APPEND-ONLY: SELECT + INSERT policies ONLY
--       (mirrors dispatch_ticket_correction / audit_log, migration 0018) —
--       a push attempt is a new row, never an edited one.
--   (2) qbo_connection.org_id is UNIQUE — exactly one QBO connection per org
--       (single-tenant-per-QBO-company-file is the correct model; an
--       operator that needs to reconnect does so via disconnect+reconnect,
--       never a second row).
--   (3) qbo_connection stores OAuth2 access/refresh tokens as PLAINTEXT TEXT
--       columns. [VERIFY-QB1-SEC-1]: token ENCRYPTION-AT-REST (e.g. pgcrypto
--       column encryption or an application-level envelope) is a FLAGGED
--       FOLLOW-UP before this table holds real operator credentials in
--       production. RLS + the non-superuser aeroops_app role are the only
--       protections in this slice.
--   (4) qbo_export_log.entity_id carries NO foreign key (polymorphic —
--       entity_type distinguishes 'invoice' vs 'customer' rows; mirrors
--       audit_log.entity_id's FK-less polymorphic pattern). A partial
--       UNIQUE index on (org_id, entity_type, entity_id) WHERE
--       status = 'exported' is the idempotency backstop: an invoice (or
--       customer) can be marked exported AT MOST ONCE per org — the command
--       layer checks this before ever calling the QBO API, but the index is
--       the structural guarantee against a racing double-push.
--   (5) qbo_account_mapping.line_kind is a per-org GL bucket key —
--       'wet_hourly' | 'dry_hourly' | 'instruction' | 'flat' | 'other' |
--       'default'. The first four mirror rate_schedule.rate_kind
--       (migration 0019) exactly; 'other' is the bucket for invoice line
--       items with no rate_schedule_id (manual/ad-hoc charges — e.g. an
--       operator-typed landing fee or fuel surcharge line); 'default' is an
--       optional catch-all row an operator may set so that any kind without
--       its own explicit mapping still exports instead of being refused.
--       UNIQUE (org_id, line_kind) — at most one QBO Item mapped per kind
--       per org. [VERIFY-QB1-B]: the rate_schedule.rate_kind CHECK domain
--       (migration 0019) is FROZEN in this slice — a future slice adding
--       dedicated kinds (e.g. landing_fee, fuel_surcharge) as first-class
--       rate kinds would give those charges their own GL bucket instead of
--       sharing 'flat'/'other'; that is an additive follow-up, not required
--       here.
--   (6) Composite FKs are all hand-written (Drizzle cannot express
--       multi-col FKs). Named constraints follow the {table}_{fk_col}_org_fk
--       convention used throughout the schema.
--   (7) STRICTLY ADDITIVE — no existing tables, columns, or constraints
--       modified. Only the three new tables are created. The billing B1
--       tables (rate_schedule/invoice/invoice_line_item, migration 0019)
--       and the dispatch/scheduling gates are READ-ONLY consumers here —
--       nothing in this migration touches them.
--   (8) NO card/bank data. NO Stripe. NO payment processing. This is a
--       bookkeeping EXPORT of operator-created invoice RECORDS that already
--       exist — QB1 never moves money and never charges anyone.
--
-- ORDER within this file:
--   (1) CREATE TABLE qbo_connection (FKs + CHECKs + UNIQUE)
--   (2) CREATE TABLE qbo_export_log (FKs + CHECKs + partial UNIQUE)
--   (3) CREATE TABLE qbo_account_mapping (FKs + CHECKs + UNIQUE)
--   (4) Indexes
--   (5) ENABLE + FORCE RLS (3 tables)
--   (6) RLS policies
--   (7) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE qbo_connection ──────────────────────────────────────────────────
--
-- One OAuth2 connection per org to the operator's own QBO company file
-- (realm). [VERIFY-QB1-SEC-1]: access_token/refresh_token are PLAINTEXT —
-- encryption-at-rest is a flagged follow-up before production use.
--
-- Composite FKs (all hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
-- CHECKs:
--   qbo_connection_status_check: status IN ('connected','disconnected','error')

CREATE TABLE "qbo_connection" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"                    uuid NOT NULL,
  "realm_id"                  text,
  "access_token"              text,
  "refresh_token"             text,
  "access_token_expires_at"   timestamptz,
  "status"                    text NOT NULL DEFAULT 'disconnected',
  "created_at"                timestamptz NOT NULL DEFAULT now(),
  "updated_at"                timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "qbo_connection_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Exactly one QBO connection per org.
  CONSTRAINT "qbo_connection_org_id_unique"
    UNIQUE ("org_id"),

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "qbo_connection_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Status must be one of the three defined values.
  CONSTRAINT "qbo_connection_status_check" CHECK (
    "status" IN ('connected', 'disconnected', 'error')
  )
);


-- ── (2) TABLE qbo_export_log ──────────────────────────────────────────────────
--
-- Append-only push-attempt history. One row per push ATTEMPT (not per
-- entity) — a retried export after an error is a NEW row, never an edit of
-- the failed one, so the full attempt history is preserved for support/audit.
--
-- entity_id carries NO foreign key — polymorphic (entity_type distinguishes
-- 'invoice' rows, which reference invoice.id, from 'customer' rows, which
-- reference app_user.id). Mirrors audit_log.entity_id exactly.
--
-- CHECKs:
--   qbo_export_log_entity_type_check: entity_type IN ('invoice','customer')
--   qbo_export_log_status_check: status IN ('pending','exported','error')
--
-- Idempotency (structural backstop, (4) above): a partial UNIQUE index on
-- (org_id, entity_type, entity_id) WHERE status = 'exported' means an
-- invoice (or customer) can be marked 'exported' AT MOST ONCE per org —
-- the command layer's pre-push idempotency check is backed by this index,
-- not merely application logic.

CREATE TABLE "qbo_export_log" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"        uuid NOT NULL,
  "entity_type"   text NOT NULL,
  "entity_id"     uuid NOT NULL,
  "qbo_id"        text,
  "status"        text NOT NULL DEFAULT 'pending',
  "error_detail"  text,
  "exported_at"   timestamptz,
  "created_at"    timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "qbo_export_log_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "qbo_export_log_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Entity type must be one of the two defined values.
  CONSTRAINT "qbo_export_log_entity_type_check" CHECK (
    "entity_type" IN ('invoice', 'customer')
  ),

  -- Status must be one of the three defined values.
  CONSTRAINT "qbo_export_log_status_check" CHECK (
    "status" IN ('pending', 'exported', 'error')
  )
);


-- ── (3) TABLE qbo_account_mapping ─────────────────────────────────────────────
--
-- Per-org, per-line-item-kind mapping to a QBO Item (income account). This
-- is the "real-time line-item GL mapping" competitive wedge: instead of one
-- lump-sum invoice line, each AeroOps invoice line item is pushed to QBO
-- under the operator's own designated Item/account for its kind.
--
-- Composite FKs (all hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT:
--     Creator must be a member of the same org. Preserves creation attribution.
--     Targets app_user_id_org_id_unique (migration 0000).
--
-- CHECKs:
--   qbo_account_mapping_line_kind_check: line_kind IN (...)
--   qbo_account_mapping_item_id_nonempty_check: char_length(btrim(qbo_item_id)) > 0
--   qbo_account_mapping_item_name_nonempty_check: char_length(btrim(qbo_item_name)) > 0
--
-- UNIQUE (org_id, line_kind): at most one QBO Item mapped per kind per org.

CREATE TABLE "qbo_account_mapping" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"         uuid NOT NULL,
  "line_kind"      text NOT NULL,
  "qbo_item_id"    text NOT NULL,
  "qbo_item_name"  text NOT NULL,
  "created_by"     uuid NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "qbo_account_mapping_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: creator must be a user in the same org.
  -- ON DELETE RESTRICT: preserves creation attribution.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "qbo_account_mapping_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "qbo_account_mapping_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- At most one QBO Item mapped per kind per org.
  CONSTRAINT "qbo_account_mapping_org_line_kind_unique"
    UNIQUE ("org_id", "line_kind"),

  -- line_kind domain: mirrors rate_schedule.rate_kind (migration 0019) plus
  -- 'other' (no-rate-schedule manual lines) and 'default' (optional catch-all).
  CONSTRAINT "qbo_account_mapping_line_kind_check" CHECK (
    "line_kind" IN ('wet_hourly', 'dry_hourly', 'instruction', 'flat', 'other', 'default')
  ),

  CONSTRAINT "qbo_account_mapping_item_id_nonempty_check" CHECK (
    char_length(btrim("qbo_item_id")) > 0
  ),

  CONSTRAINT "qbo_account_mapping_item_name_nonempty_check" CHECK (
    char_length(btrim("qbo_item_name")) > 0
  )
);


-- ── (4) Indexes ───────────────────────────────────────────────────────────────

-- qbo_export_log: recent-history lookups + idempotency probe.
-- e.g. getQboStatus: WHERE org_id=$1 ORDER BY created_at DESC LIMIT 20
-- e.g. idempotency check: WHERE org_id=$1 AND entity_type=$2 AND entity_id=$3
CREATE INDEX "qbo_export_log_org_created_idx"
  ON "qbo_export_log" ("org_id", "created_at" DESC);

CREATE INDEX "qbo_export_log_org_entity_idx"
  ON "qbo_export_log" ("org_id", "entity_type", "entity_id");

-- Idempotency backstop: an entity may be marked 'exported' at most once per org.
CREATE UNIQUE INDEX "qbo_export_log_org_entity_exported_unique"
  ON "qbo_export_log" ("org_id", "entity_type", "entity_id")
  WHERE "status" = 'exported';

-- qbo_account_mapping: full-mapping-table read for the settings card + exporter.
CREATE INDEX "qbo_account_mapping_org_idx"
  ON "qbo_account_mapping" ("org_id");


-- ── (5) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "qbo_connection"       ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "qbo_connection"       FORCE   ROW LEVEL SECURITY;

ALTER TABLE "qbo_export_log"       ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "qbo_export_log"       FORCE   ROW LEVEL SECURITY;

ALTER TABLE "qbo_account_mapping"  ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "qbo_account_mapping"  FORCE   ROW LEVEL SECURITY;


-- ── (6) RLS policies ──────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)

-- ── qbo_connection policies (standard 4-policy pattern) ────────────────────────

CREATE POLICY "qbo_connection_select"
  ON "qbo_connection"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "qbo_connection_insert"
  ON "qbo_connection"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "qbo_connection_update"
  ON "qbo_connection"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "qbo_connection_delete"
  ON "qbo_connection"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── qbo_export_log policies — APPEND-ONLY (SELECT + INSERT only) ──────────────
-- Mirrors dispatch_ticket_correction (migration 0018) / audit_log exactly:
-- no UPDATE or DELETE policy. With FORCE ROW LEVEL SECURITY, the absence of
-- a permissive policy for UPDATE/DELETE blocks those operations for ALL
-- roles, including the table owner — the structural guarantee that a push
-- history row is immutable once inserted.

CREATE POLICY "qbo_export_log_select"
  ON "qbo_export_log"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "qbo_export_log_insert"
  ON "qbo_export_log"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── qbo_account_mapping policies (standard 4-policy pattern) ───────────────────

CREATE POLICY "qbo_account_mapping_select"
  ON "qbo_account_mapping"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "qbo_account_mapping_insert"
  ON "qbo_account_mapping"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "qbo_account_mapping_update"
  ON "qbo_account_mapping"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "qbo_account_mapping_delete"
  ON "qbo_account_mapping"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (7) GRANT to aeroops_app ──────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "qbo_connection"      TO aeroops_app;
GRANT SELECT, INSERT               ON "qbo_export_log"        TO aeroops_app;
REVOKE UPDATE, DELETE              ON "qbo_export_log"        FROM aeroops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "qbo_account_mapping"   TO aeroops_app;
