-- ============================================================
-- AeroOps — Slice PB1.1: booking_request table (public booking lead-capture)
-- Migration: 0015_booking_request.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql + 0001_auth_credential.sql
--               + 0002_scheduling.sql + 0003_booking_policies.sql
--               + 0004_recurrence.sql + 0005_dispatch.sql
--               + 0006_squawks_grounding.sql + 0007_fleet.sql
--               + 0008_people.sql + 0009_dispatch_gate.sql
--               + 0010_civil_twilight.sql + 0011_optimizer_run.sql
--               + 0012_training.sql + 0013_work_orders.sql
--               + 0014_availability.sql
--               must already be applied.
--
-- Adds the Slice PB1.1 data-model delta:
--   (1) CREATE TABLE booking_request + named FKs + 5 CHECKs
--   (2) CREATE UNIQUE INDEX booking_request_id_org_id_unique
--   (3) CREATE INDEX booking_request_org_status_created_idx
--   (4) ENABLE + FORCE RLS on booking_request; 4 named policies; GRANT
--
-- ── ADR-0013 security model ───────────────────────────────────────────────────
-- The anon public submit path:
--   (a) resolves org_id ONLY from resolveOrgBySlug (server-side; NOT client input)
--   (b) calls withOrgContext(db, resolvedOrg.id, tx => { INSERT ... }) so the
--       booking_request_insert WITH CHECK (org_id = current_org_id) policy is
--       the structural backstop — a bug cannot smuggle a different org_id.
--   (c) does NOT use withPlatformAdminContext (which would bypass RLS).
-- The INSERT policy is load-bearing for the anon write path.
--
-- INVARIANT: the anon tx body is INSERT-only; org_id bound ONLY from
-- resolveOrgBySlug. Reviewer must reject any violation.
--
-- Key guarantees:
--   (1) org_id NOT NULL, ENABLE+FORCE RLS, 4 fail-closed named policies,
--       aeroops_app GRANT (ADR-0001 byte-pattern).
--   (2) All composite FKs are hand-written (Drizzle cannot express multi-col FKs).
--   (3) Composite FK (handled_by, org_id) → app_user ON DELETE SET NULL uses
--       column-list syntax: ON DELETE SET NULL (handled_by) — ONLY handled_by is
--       nulled; org_id is NEVER nulled. This mirrors the dispatch_ticket.closed_by
--       fix guidance. Durable "who" in audit_log.
--   (4) booking_request_handled_shape_check mirrors squawk_resolved_shape_check:
--       handled_by NOT in the NOT-NULL arm (SET NULL; durable who in audit_log).
--   (5) Requester fields are write-once (no UPDATE column restriction at DB level;
--       enforced at the API layer — only triage fields are mutable via the triage
--       path). NO reservation FK, NO requester FK (anon by design).
--   (6) NO money column anywhere. NO FAA regulatory data.
--   (7) STRICTLY ADDITIVE — no existing tables, columns, or constraints modified.
--
-- [VERIFY-PB1-COMP-1]: PII lead-data storage + retention/purge posture before
-- public launch (low risk — minimum volunteered data, no financial data).
-- [VERIFY-PB1-SEC-1] (HARD LAUNCH PREDECESSOR, not a build blocker): edge
-- rate-limiter / WAF + CAPTCHA before public exposure.
--
-- ORDER:
--   (1) CREATE TABLE booking_request + named FKs + 5 CHECKs
--   (2) CREATE UNIQUE INDEX booking_request_id_org_id_unique
--   (3) CREATE INDEX booking_request_org_status_created_idx
--   (4) ENABLE + FORCE RLS; 4 named policies; GRANT
-- ============================================================


-- ── (1) CREATE TABLE booking_request ─────────────────────────────────────────
--
-- Lead-capture record from the public booking page. Requester is anonymous —
-- there is no session, no app_user row for the requester.
--
-- Requester fields (requester_name / requester_email / requester_phone /
-- requested_start / requested_end / aircraft_type_pref / message):
--   Write-once — set at INSERT, never mutated by any code path.
--
-- Triage fields (status / handled_by / handled_at / triage_notes):
--   Staff-mutable via the booking:triage-gated triage path (session-scoped,
--   normal RLS). Status transitions: new→contacted|declined,
--   contacted→converted|declined|contacted.
--
-- Composite FKs (hand-written; Drizzle cannot express multi-column FKs):
--
--   FK (org_id) → org(id) ON DELETE CASCADE  [booking_request_org_id_fk]
--     Tenant spine — deleting an org cascades to its booking requests.
--
--   Composite FK (handled_by, org_id) → app_user(id, org_id) ON DELETE SET NULL (handled_by)
--     [booking_request_handled_by_org_fk]
--     Column-list SET NULL: only handled_by is nulled; org_id is NEVER touched.
--     Prevents cross-org handler references. If the handling user is hard-deleted
--     the record is preserved with handled_by = NULL (durable "who" in audit_log).
--     Targets app_user_id_org_id_unique established in migration 0000.
--
-- CHECKs:
--   booking_request_status_check:
--     status IN ('new', 'contacted', 'converted', 'declined')
--
--   booking_request_requester_name_nonempty_check:
--     char_length(btrim(requester_name)) > 0
--
--   booking_request_requester_email_nonempty_check:
--     char_length(btrim(requester_email)) > 0
--
--   booking_request_end_after_start_check:
--     requested_end IS NULL OR requested_end > requested_start
--
--   booking_request_handled_shape_check:
--     (status = 'new' AND handled_by IS NULL AND handled_at IS NULL)
--     OR (status IN ('contacted', 'converted', 'declined') AND handled_at IS NOT NULL)
--     (handled_by intentionally NOT in the NOT-NULL arm — ON DELETE SET NULL;
--     durable "who" in audit_log. Mirrors squawk_resolved_shape_check rationale.)

CREATE TABLE "booking_request" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"                uuid NOT NULL,
  "status"                text NOT NULL DEFAULT 'new',

  -- Write-once requester fields (set at INSERT, never mutated).
  "requester_name"        text NOT NULL,
  "requester_email"       text NOT NULL,
  "requester_phone"       text,
  "requested_start"       timestamptz NOT NULL,
  "requested_end"         timestamptz,
  "aircraft_type_pref"    text,
  "message"               text,

  -- Staff-mutable triage fields (session-gated, booking:triage cap).
  "handled_by"            uuid,
  "handled_at"            timestamptz,
  "triage_notes"          text,

  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "booking_request_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: handler must be a user in the same org.
  -- ON DELETE SET NULL (handled_by): column-list syntax — ONLY handled_by is
  -- nulled; org_id is NEVER touched. Prevents cross-org handler references.
  -- Targets app_user_id_org_id_unique from migration 0000.
  CONSTRAINT "booking_request_handled_by_org_fk"
    FOREIGN KEY ("handled_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE SET NULL (handled_by),

  -- Status domain: new | contacted | converted | declined.
  CONSTRAINT "booking_request_status_check"
    CHECK ("status" IN ('new', 'contacted', 'converted', 'declined')),

  -- Requester name must be non-empty (not blank-only).
  CONSTRAINT "booking_request_requester_name_nonempty_check"
    CHECK (char_length(btrim("requester_name")) > 0),

  -- Requester email must be non-empty (not blank-only).
  -- Format validation (RFC 5321, ≤254 chars) is enforced at the app layer.
  CONSTRAINT "booking_request_requester_email_nonempty_check"
    CHECK (char_length(btrim("requester_email")) > 0),

  -- End must be after start when provided.
  CONSTRAINT "booking_request_end_after_start_check"
    CHECK ("requested_end" IS NULL OR "requested_end" > "requested_start"),

  -- Shape invariant per status.
  -- new   ⇒ handled_by IS NULL AND handled_at IS NULL (not yet triaged).
  -- other ⇒ handled_at IS NOT NULL (triage timestamp required).
  -- handled_by intentionally NOT in the NOT-NULL arm (ON DELETE SET NULL;
  -- durable "who" in audit_log). Mirrors squawk_resolved_shape_check.
  CONSTRAINT "booking_request_handled_shape_check"
    CHECK (
      (  "status" = 'new'
         AND "handled_by" IS NULL
         AND "handled_at" IS NULL
      )
      OR
      (  "status" IN ('contacted', 'converted', 'declined')
         AND "handled_at" IS NOT NULL
      )
    )
);


-- ── (2) UNIQUE (id, org_id) on booking_request ───────────────────────────────
-- Composite candidate key — forward-compat for future composite FKs and
-- consistent with all other tenant tables.

CREATE UNIQUE INDEX "booking_request_id_org_id_unique"
  ON "booking_request" ("id", "org_id");


-- ── (3) Index (org_id, status, created_at DESC) on booking_request ────────────
-- Covers: triage inbox (newest-first filtered by status) AND the per-org soft
-- rate-count guard (COUNT for org_id in the last N seconds).
-- e.g. listBookingRequests: WHERE org_id=$1 [AND status=$2] ORDER BY created_at DESC
--      rate guard:           WHERE org_id=$1 AND status='new' AND created_at > now()-interval

CREATE INDEX "booking_request_org_status_created_idx"
  ON "booking_request" ("org_id", "status", "created_at" DESC);


-- ── (4) ENABLE + FORCE RLS on booking_request; 4 policies; GRANT ─────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.
--
-- INSERT WITH CHECK is load-bearing for the ADR-0013 anon write path:
-- the anon submit calls withOrgContext(db, resolvedOrg.id, ...) which sets
-- the GUC; the WITH CHECK ensures the inserted row's org_id matches — a bug
-- cannot smuggle a different org_id into the row.
--
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows (fail-closed)
-- Byte-identical to 0014 (resource_availability_window) pattern.

ALTER TABLE "booking_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "booking_request" FORCE  ROW LEVEL SECURITY;

CREATE POLICY "booking_request_select"
  ON "booking_request"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "booking_request_insert"
  ON "booking_request"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "booking_request_update"
  ON "booking_request"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "booking_request_delete"
  ON "booking_request"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "booking_request" TO aeroops_app;
