-- ============================================================
-- AeroOps — Slice FC-P1: Member messaging / announcements
-- Migration: 0036_member_message.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0035_study_grant.sql must
--               already be applied.
--
-- CONTEXT: Flight Schedule Pro parity item "Engage with Messaging by Email" —
-- an operator (owner/manager) sends a one-off announcement email to some or
-- all of its active members. AeroOps already has transactional, per-event
-- notifications (migration 0026); this is the first OPERATOR-AUTHORED
-- broadcast surface.
--
--   member_message — APPEND-ONLY record of each announcement SENT (mirrors
--     notification_log / dues_run / ledger_entry / stripe_event: SELECT +
--     INSERT RLS policies ONLY). One row per sendMemberMessage call,
--     regardless of how many recipients it fanned out to — the per-recipient
--     send attempts are recorded separately, in the EXISTING notification_log
--     table (event_type = 'org.announcement'), via the existing
--     sendNotification dispatcher. This table exists to answer "what did we
--     send, to whom (by audience), and how many people did it reach" without
--     re-deriving it from notification_log.
--
-- Key guarantees:
--   (1) Tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS + the standard
--       current_org_id GUC predicate.
--   (2) APPEND-ONLY: GRANT is SELECT+INSERT only; REVOKE UPDATE, DELETE is an
--       explicit belt-and-suspenders backstop (mirrors notification_log in
--       migration 0026) — an announcement, once sent, is never edited or
--       un-sent.
--   (3) Composite FK (hand-written; Drizzle cannot express multi-column
--       FKs), mirroring study_grant.granted_by exactly:
--         (org_id) → org(id) ON DELETE CASCADE.
--         (sent_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT —
--           attribution on who sent the announcement is preserved (mirrors
--           study_grant_granted_by_org_fk / block_package_created_by_org_fk).
--   (4) UNIQUE (id, org_id) composite candidate key — consistent with all
--       other tenant tables.
--   (5) subject / body are non-empty (trimmed) with a sane length cap
--       (subject <= 200 chars, body <= 5000 chars) — CHECK constraints.
--       Plain text ONLY; there is no HTML column — the web layer renders
--       body as escaped text, and the email template treats it as text (see
--       packages/api/src/notifications/templates.ts).
--   (6) audience is 'all_active' or 'role' (CHECK); role is REQUIRED iff
--       audience='role' and otherwise must be NULL (CHECK), and when present
--       must be a valid membership_role value (CHECK, mirrors
--       MEMBERSHIP_ROLES in packages/core/src/roles.ts — TEXT + CHECK, not a
--       pgEnum FK, since this is a filter value, not a relationship).
--   (7) recipient_count is a NOT NULL non-negative integer snapshot of how
--       many recipients were resolved at send time (CHECK >= 0).
--   (8) STRICTLY ADDITIVE — no existing table/column/constraint is touched.
--       The FROZEN dispatch gate and every other engine are untouched. NO
--       money moves here; no Stripe, no card/bank data.
--
-- ORDER within this file:
--   (1) CREATE TABLE member_message (FKs + CHECKs)
--   (2) Indexes
--   (3) ENABLE + FORCE RLS
--   (4) RLS policies (SELECT + INSERT only — append-only)
--   (5) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE member_message ──────────────────────────────────────────────────

CREATE TABLE "member_message" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"           uuid NOT NULL,
  "sent_by"          uuid NOT NULL,
  "subject"          text NOT NULL,
  "body"             text NOT NULL,
  "audience"         text NOT NULL,
  "role"             text,
  "recipient_count"  integer NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "member_message_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the sending staff member must be in the same org.
  -- ON DELETE RESTRICT: attribution on who sent the announcement is
  -- preserved (mirrors study_grant_granted_by_org_fk).
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "member_message_sent_by_org_fk"
    FOREIGN KEY ("sent_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "member_message_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Non-empty, sanely-bounded plain text. NO HTML column — the web layer
  -- escapes on render and the email template treats body as text.
  CONSTRAINT "member_message_subject_check" CHECK (
    char_length(btrim("subject")) > 0 AND char_length("subject") <= 200
  ),
  CONSTRAINT "member_message_body_check" CHECK (
    char_length(btrim("body")) > 0 AND char_length("body") <= 5000
  ),

  CONSTRAINT "member_message_audience_check" CHECK (
    "audience" IN ('all_active', 'role')
  ),

  -- role is REQUIRED iff audience='role', and otherwise must be NULL.
  CONSTRAINT "member_message_role_required_iff_audience_check" CHECK (
    ("audience" = 'role' AND "role" IS NOT NULL) OR
    ("audience" = 'all_active' AND "role" IS NULL)
  ),

  -- When present, role must be a valid membership_role value. Mirrors
  -- MEMBERSHIP_ROLES in packages/core/src/roles.ts. TEXT + CHECK (not a
  -- pgEnum FK) — this is a filter value, not a relationship to a row.
  CONSTRAINT "member_message_role_valid_check" CHECK (
    "role" IS NULL OR "role" IN (
      'owner', 'manager', 'dispatcher', 'cfi', 'mechanic', 'renter',
      'student', 'accountant'
    )
  ),

  CONSTRAINT "member_message_recipient_count_nonnegative_check" CHECK (
    "recipient_count" >= 0
  )
);


-- ── (2) Indexes ───────────────────────────────────────────────────────────────

-- Sent-history listing (newest first), org-scoped.
CREATE INDEX "member_message_org_created_idx"
  ON "member_message" ("org_id", "created_at" DESC);


-- ── (3) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "member_message" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "member_message" FORCE   ROW LEVEL SECURITY;


-- ── (4) RLS policies — APPEND-ONLY (SELECT + INSERT only) ────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)
--
-- Mirrors notification_log / dues_run / ledger_entry exactly: no UPDATE or
-- DELETE policy. With FORCE ROW LEVEL SECURITY, the absence of a permissive
-- policy blocks those operations for ALL roles, including the table owner —
-- the structural guarantee that a member_message row is immutable once
-- inserted.

CREATE POLICY "member_message_select"
  ON "member_message"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "member_message_insert"
  ON "member_message"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (5) GRANT to aeroops_app ───────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT ON "member_message" TO aeroops_app;
REVOKE UPDATE, DELETE ON "member_message" FROM aeroops_app;
