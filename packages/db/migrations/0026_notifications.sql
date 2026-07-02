-- ============================================================
-- AeroOps — Slice P1.3: Email notifications
-- Migration: 0026_notifications.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0025_recurring_dues.sql
--               must already be applied.
--
-- Implements P1.3: best-effort email notifications for a small set of
-- operational events (reservation created, squawk reported, aircraft
-- grounded, invoice finalized, payment failed, dues generated). NO SMS,
-- NO push, NO digest batching in this slice (see docs/specs/slice-p1-
-- notifications.md for the deferred list).
--
--   notification_log — APPEND-ONLY audit of every send ATTEMPT (mirrors
--     ledger_entry / dues_run / audit_log / dispatch_ticket_correction /
--     stripe_event: SELECT + INSERT RLS policies ONLY). Records the
--     recipient email + subject ONLY — NEVER the rendered body (no PII
--     beyond the recipient address + a short subject line survives here).
--   notification_pref — per-user per-event-type opt-out. Absence of a row
--     for a given (user, event_type) means "enabled" (default opt-IN) —
--     enforced entirely in application code (sendNotification), NOT by
--     this schema. Standard 4-policy (mutable) RLS, mirrors dues_schedule.
--
-- Key guarantees:
--   (1) Both tables are tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS +
--       the standard current_org_id GUC predicate.
--   (2) notification_log is APPEND-ONLY: GRANT is SELECT+INSERT only;
--       REVOKE UPDATE, DELETE is an explicit belt-and-suspenders backstop
--       (mirrors migration 0025's dues_run / 0022's ledger_entry).
--   (3) notification_log.user_id is a SIMPLE (non-composite) nullable FK to
--       app_user(id) ON DELETE SET NULL — mirrors audit_log.actor_user_id
--       exactly (migration 0000). A simple FK (not composite-to-org) is the
--       established house pattern for a nullable "who" column on an
--       append-only log table; RLS + application-level org-scoping (the
--       row is always inserted with org_id = the acting session's org)
--       is what keeps this tenant-safe, not the FK shape. This deliberately
--       avoids the composite-FK-with-ON-DELETE-SET-NULL class of bug noted
--       against dispatch_ticket.closed_by in migration 0005 (column-list
--       syntax needed for a composite ON DELETE SET NULL) — a plain FK has
--       no such footgun.
--   (4) notification_pref.user_id is NOT NULL with a COMPOSITE FK
--       (user_id, org_id) -> app_user(id, org_id) ON DELETE CASCADE — a
--       preference row has no meaning once its user is gone, so CASCADE
--       (not RESTRICT) is correct here (unlike dues_schedule's history-
--       preserving RESTRICT).
--   (5) notification_log.channel is constrained to 'email' only (CHECK) —
--       a forward seam for SMS/push without a schema change beyond
--       widening this CHECK (see docs/specs/slice-p1-notifications.md
--       deferred list).
--   (6) notification_log.status is constrained to 'sent'|'failed'|'skipped'
--       (CHECK).
--   (7) notification_log.event_type is free text (NOT an enum/CHECK) — new
--       event types can be added without a migration, matching how
--       audit_log.action is unconstrained free text.
--   (8) UNIQUE (org_id, user_id, event_type) on notification_pref is the
--       upsert target for setMyNotificationPref (ON CONFLICT DO UPDATE).
--   (9) STRICTLY ADDITIVE — no existing tables/columns/constraints modified.
--       Only the two new tables are created.
--  (10) NO Stripe/card/bank columns; NO money moved by this migration or
--       any code that only sends a best-effort email.
--
-- ORDER within this file:
--   (1) CREATE TABLE notification_log (FKs + CHECKs)
--   (2) CREATE TABLE notification_pref (FKs + CHECK + UNIQUE)
--   (3) Indexes
--   (4) ENABLE + FORCE RLS (2 tables)
--   (5) RLS policies
--   (6) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE notification_log ──────────────────────────────────────────────
--
-- APPEND-ONLY audit of every send ATTEMPT (sent / failed / skipped). Written
-- by sendNotification (packages/api/src/notifications/send-notification.ts)
-- exactly once per call, regardless of outcome.
--
-- Composite FKs (hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   FK (user_id) → app_user(id) ON DELETE SET NULL:
--     The recipient. SIMPLE (non-composite) FK — mirrors audit_log.
--     actor_user_id exactly (migration 0000). Nullable: a future org-level
--     notification (no single recipient user) is representable without a
--     schema change.

CREATE TABLE "notification_log" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"       uuid NOT NULL,
  "user_id"      uuid,
  "channel"      text NOT NULL,
  "event_type"   text NOT NULL,
  "to_email"     text NOT NULL,
  "subject"      text NOT NULL,
  "status"       text NOT NULL,
  "error_detail" text,
  "created_at"   timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "notification_log_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Simple (non-composite) FK — mirrors audit_log.actor_user_id.
  CONSTRAINT "notification_log_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE SET NULL,

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "notification_log_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Forward seam for SMS/push: widen this CHECK when a second channel ships.
  CONSTRAINT "notification_log_channel_check" CHECK (
    "channel" IN ('email')
  ),

  CONSTRAINT "notification_log_status_check" CHECK (
    "status" IN ('sent', 'failed', 'skipped')
  )
);


-- ── (2) TABLE notification_pref ─────────────────────────────────────────────
--
-- Per-user per-event-type opt-out. Absence of a row for a given
-- (org_id, user_id, event_type) means "enabled" — sendNotification treats a
-- missing row as email_enabled = true (default opt-IN), enforced entirely in
-- application code, NOT by a DEFAULT on a NOT-EXISTS row (there is no such
-- thing as a DEFAULT on a missing row).
--
-- Composite FK (hand-written):
--
--   FK (org_id) → org(id) ON DELETE CASCADE:
--     Tenant spine.
--
--   Composite FK (user_id, org_id) → app_user(id, org_id) ON DELETE CASCADE:
--     A preference row has no meaning once its user is gone — CASCADE
--     (unlike dues_schedule's history-preserving RESTRICT).
--     Targets app_user_id_org_id_unique (migration 0000).

CREATE TABLE "notification_pref" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"         uuid NOT NULL,
  "user_id"        uuid NOT NULL,
  "event_type"     text NOT NULL,
  "email_enabled"  boolean NOT NULL DEFAULT true,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "notification_pref_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the pref's user must be in the same org. CASCADE — a pref
  -- row has no meaning once its user is gone.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "notification_pref_user_org_fk"
    FOREIGN KEY ("user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE CASCADE,

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "notification_pref_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- THE UPSERT TARGET for setMyNotificationPref (ON CONFLICT DO UPDATE).
  CONSTRAINT "notification_pref_org_user_event_unique"
    UNIQUE ("org_id", "user_id", "event_type")
);


-- ── (3) Indexes ───────────────────────────────────────────────────────────────

-- notification_log: recent-history reads (support/ops) + per-user lookups.
CREATE INDEX "notification_log_org_created_idx"
  ON "notification_log" ("org_id", "created_at" DESC);

CREATE INDEX "notification_log_org_user_idx"
  ON "notification_log" ("org_id", "user_id");

-- notification_pref: the UNIQUE (org_id, user_id, event_type) above already
-- indexes exact-match lookups AND the (org_id, user_id) prefix (getMy
-- NotificationPrefs reads WHERE org_id=$1 AND user_id=$2) — no separate
-- index needed.


-- ── (4) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "notification_log"  ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "notification_log"  FORCE   ROW LEVEL SECURITY;

ALTER TABLE "notification_pref" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "notification_pref" FORCE   ROW LEVEL SECURITY;


-- ── (5) RLS policies ──────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)

-- ── notification_log policies — APPEND-ONLY (SELECT + INSERT only) ───────────
-- Mirrors dues_run / ledger_entry / dispatch_ticket_correction / stripe_event
-- exactly: no UPDATE or DELETE policy. With FORCE ROW LEVEL SECURITY, the
-- absence of a permissive policy blocks those operations for ALL roles,
-- including the table owner — the structural guarantee that a
-- notification_log row is immutable once inserted.

CREATE POLICY "notification_log_select"
  ON "notification_log"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "notification_log_insert"
  ON "notification_log"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- ── notification_pref policies (standard 4-policy pattern) ───────────────────

CREATE POLICY "notification_pref_select"
  ON "notification_pref"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "notification_pref_insert"
  ON "notification_pref"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "notification_pref_update"
  ON "notification_pref"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "notification_pref_delete"
  ON "notification_pref"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (6) GRANT to aeroops_app ───────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT ON "notification_log" TO aeroops_app;
REVOKE UPDATE, DELETE ON "notification_log" FROM aeroops_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_pref" TO aeroops_app;
