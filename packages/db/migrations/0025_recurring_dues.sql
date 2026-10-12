-- ============================================================
-- AeroOps — Slice P0-REV: Recurring dues
-- Migration: 0025_recurring_dues.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0024_payment_methods_autopay.sql
--               must already be applied.
--
-- Implements P0-REV part 4: recurring (monthly) member dues. A DRAFT invoice
-- is generated per active dues_schedule per calendar period by
-- generateDuesInvoices; finalizing that invoice flows into the auto-pay path
-- built in migration 0024 (unchanged — this migration adds NO new
-- finalize/autopay logic, only the schedule + the idempotency marker).
--
--   dues_schedule — an operator-configured recurring-dues line for one member.
--   dues_run      — APPEND-ONLY period marker: the STRUCTURAL no-double-bill
--     mechanism. UNIQUE (org_id, dues_schedule_id, period_key) means running
--     generateDuesInvoices twice for the same month can never create two
--     invoices for the same schedule.
--
-- Key guarantees:
--   (1) dues_schedule is tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS +
--       the standard 4-policy pattern (mirrors migration 0019 rate_schedule).
--   (2) dues_run is tenant-scoped + APPEND-ONLY: ENABLE+FORCE RLS + SELECT +
--       INSERT policies ONLY (mirrors ledger_entry / dispatch_ticket_correction
--       / stripe_event — migrations 0022/0018/0023). GRANT is SELECT+INSERT
--       only; REVOKE UPDATE, DELETE is an explicit belt-and-suspenders
--       backstop. No updated_at — invoice_id is set at INSERT time (the
--       command creates the invoice FIRST, then inserts the dues_run row
--       carrying that invoice's id — see generateDuesInvoices).
--   (3) THE STRUCTURAL IDEMPOTENCY MECHANISM: UNIQUE (org_id, dues_schedule_id,
--       period_key) on dues_run. generateDuesInvoices attempts
--       INSERT ... ON CONFLICT DO NOTHING RETURNING id for this triple BEFORE
--       committing to having created an invoice for that (schedule, period);
--       a conflict means "already run this period" and the command skips
--       (rolling back to a SAVEPOINT if an invoice was tentatively created
--       first — see the command's comment for the exact ordering).
--   (4) amount_cents (dues_schedule) is a POSITIVE integer (CHECK > 0) —
--       INTEGER CENTS, never a float.
--   (5) day_of_month is bounded 1–28 (CHECK) — avoids short-month drift
--       (no Feb 30). Informational only: this migration/table does NOT
--       itself schedule anything — invocation is a manual staff action
--       (runDuesForPeriodAction) or later maintainer-infra cron; day_of_month
--       is display/planning metadata for the operator.
--   (6) cadence is constrained to 'monthly' only (CHECK) — a forward seam
--       for other cadences (weekly/quarterly) without a schema change beyond
--       widening this CHECK.
--   (7) period_key format is enforced: CHECK ~ '^[0-9]{4}-[0-9]{2}$' ("YYYY-MM").
--   (8) Composite FKs are all hand-written (Drizzle cannot express multi-col
--       FKs). Named constraints follow the {table}_{fk_col}_org_fk convention.
--   (9) STRICTLY ADDITIVE — no existing tables/columns/constraints modified.
--       Only the two new tables are created.
--  (10) NO Stripe/card/bank columns anywhere in this migration. NO money is
--       CHARGED by this migration or any code that only creates DRAFT
--       invoices — charging (if the member has autopay configured) happens
--       ONLY when the resulting invoice is later finalized, via the
--       unchanged (migration 0024) autopay path.
--
-- ORDER within this file:
--   (1) CREATE TABLE dues_schedule (FKs + CHECKs)
--   (2) CREATE TABLE dues_run (FKs + CHECK + UNIQUE — the idempotency key)
--   (3) Indexes
--   (4) ENABLE + FORCE RLS (2 tables)
--   (5) RLS policies
--   (6) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE dues_schedule ────────────────────────────────────────────────────
--
-- An operator-configured recurring-dues line for one member: amount + cadence
-- + a nominal day-of-month + active flag + free-text memo.
--
-- Composite FKs (all hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   Composite FK (user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT:
--     The dues-payer must be a user in the same org.
--     Targets app_user_id_org_id_unique (migration 0000).
--
--   Composite FK (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT:
--     The creating staff member must be a user in the same org. Nullable —
--     NULL only if somehow created system-side (never by any command in this
--     slice; every dues_schedule command sets it to session.userId).
--     Targets app_user_id_org_id_unique (migration 0000).

CREATE TABLE "dues_schedule" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"       uuid NOT NULL,
  "user_id"      uuid NOT NULL,
  "amount_cents" integer NOT NULL,
  "cadence"      text NOT NULL DEFAULT 'monthly',
  "day_of_month" integer NOT NULL,
  "active"       boolean NOT NULL DEFAULT true,
  "memo"         text,
  "created_by"   uuid,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "dues_schedule_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the dues-payer must be a user in the same org.
  -- ON DELETE RESTRICT: preserves billing configuration history.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "dues_schedule_user_org_fk"
    FOREIGN KEY ("user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: the creating staff member must be a user in the same org.
  -- Nullable; ON DELETE RESTRICT preserves creation attribution.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "dues_schedule_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all other tenant tables;
  -- consumed by dues_run(dues_schedule_id, org_id) composite FK.
  CONSTRAINT "dues_schedule_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- INTEGER CENTS, never a float. Must be a positive charge.
  CONSTRAINT "dues_schedule_amount_positive_check" CHECK (
    "amount_cents" > 0
  ),

  -- Forward seam for other cadences without a schema change beyond widening
  -- this CHECK.
  CONSTRAINT "dues_schedule_cadence_check" CHECK (
    "cadence" IN ('monthly')
  ),

  -- Avoids short-month drift (no Feb 30). Informational/planning only — this
  -- table does not itself schedule anything (no cron in this slice).
  CONSTRAINT "dues_schedule_day_of_month_check" CHECK (
    "day_of_month" BETWEEN 1 AND 28
  )
);


-- ── (2) TABLE dues_run ────────────────────────────────────────────────────────
--
-- APPEND-ONLY period marker — the STRUCTURAL no-double-bill mechanism.
-- generateDuesInvoices creates the DRAFT invoice (+ its one line item) FIRST,
-- then inserts this marker carrying that invoice's id — see the command's
-- comment for the exact ordering (a SAVEPOINT rollback discards the
-- tentative invoice if the marker INSERT conflicts, i.e. this period was
-- already run for this schedule by a concurrent/earlier call).
--
-- Composite FKs (all hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   Composite FK (dues_schedule_id, org_id) → dues_schedule(id, org_id)
--     ON DELETE RESTRICT:
--     The marker must reference a schedule in the same org. RESTRICT
--     preserves generation history.
--     Targets dues_schedule_id_org_id_unique (created above, same migration).
--
--   Composite FK (invoice_id, org_id) → invoice(id, org_id) ON DELETE RESTRICT:
--     The marker must reference the invoice it generated, in the same org.
--     Targets invoice_id_org_id_unique (migration 0019).
--
-- UNIQUE (org_id, dues_schedule_id, period_key): THE IDEMPOTENCY KEY. A given
--   schedule can produce AT MOST ONE dues_run row (and therefore at most one
--   generated invoice) per period.
-- No updated_at — rows are immutable once inserted (mirrors audit_log /
--   dispatch_ticket_correction / stripe_event).

CREATE TABLE "dues_run" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"            uuid NOT NULL,
  "dues_schedule_id"  uuid NOT NULL,
  "period_key"        text NOT NULL,
  "invoice_id"        uuid NOT NULL,
  "created_at"        timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "dues_run_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the marker's schedule must be in the same org.
  -- ON DELETE RESTRICT: preserves generation history.
  -- Targets dues_schedule_id_org_id_unique (created above, same migration).
  CONSTRAINT "dues_run_schedule_org_fk"
    FOREIGN KEY ("dues_schedule_id", "org_id")
    REFERENCES "dues_schedule"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: the marker's invoice must be in the same org.
  -- ON DELETE RESTRICT: preserves the schedule↔invoice link.
  -- Targets invoice_id_org_id_unique (migration 0019).
  CONSTRAINT "dues_run_invoice_org_fk"
    FOREIGN KEY ("invoice_id", "org_id")
    REFERENCES "invoice"("id", "org_id") ON DELETE RESTRICT,

  -- THE IDEMPOTENCY KEY: a schedule generates AT MOST ONE invoice per period.
  CONSTRAINT "dues_run_org_schedule_period_unique"
    UNIQUE ("org_id", "dues_schedule_id", "period_key"),

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "dues_run_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- "YYYY-MM" format.
  CONSTRAINT "dues_run_period_key_format_check" CHECK (
    "period_key" ~ '^[0-9]{4}-[0-9]{2}$'
  )
);


-- ── (3) Indexes ───────────────────────────────────────────────────────────────

-- dues_schedule: per-org active-schedule listing (generateDuesInvoices reads
-- WHERE org_id=$1 AND active=true).
CREATE INDEX "dues_schedule_org_active_idx"
  ON "dues_schedule" ("org_id", "active");

-- dues_schedule: per-member schedule listing (getMemberBillingProfile).
CREATE INDEX "dues_schedule_org_user_idx"
  ON "dues_schedule" ("org_id", "user_id");

-- dues_run: recent-history reads (support/audit) + per-schedule listing.
-- The UNIQUE (org_id, dues_schedule_id, period_key) above already indexes
-- exact-match lookups; this covers per-org recency ordering.
CREATE INDEX "dues_run_org_created_idx"
  ON "dues_run" ("org_id", "created_at" DESC);


-- ── (4) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "dues_schedule" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "dues_schedule" FORCE   ROW LEVEL SECURITY;

ALTER TABLE "dues_run"      ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "dues_run"      FORCE   ROW LEVEL SECURITY;


-- ── (5) RLS policies ──────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)

-- ── dues_schedule policies (standard 4-policy pattern) ────────────────────────

CREATE POLICY "dues_schedule_select"
  ON "dues_schedule"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "dues_schedule_insert"
  ON "dues_schedule"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "dues_schedule_update"
  ON "dues_schedule"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "dues_schedule_delete"
  ON "dues_schedule"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── dues_run policies — APPEND-ONLY (SELECT + INSERT only) ────────────────────
-- Mirrors ledger_entry / dispatch_ticket_correction / stripe_event exactly: no
-- UPDATE or DELETE policy. With FORCE ROW LEVEL SECURITY, the absence of a
-- permissive policy blocks those operations for ALL roles, including the
-- table owner — the structural guarantee that a dues_run marker is immutable
-- once inserted (the idempotency mechanism depends on this).

CREATE POLICY "dues_run_select"
  ON "dues_run"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "dues_run_insert"
  ON "dues_run"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (6) GRANT to aeroops_app ───────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "dues_schedule" TO aeroops_app;

GRANT SELECT, INSERT ON "dues_run" TO aeroops_app;
REVOKE UPDATE, DELETE ON "dues_run" FROM aeroops_app;
