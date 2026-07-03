-- ============================================================
-- AeroOps — Slice 4M-REVOKE: Mobile refresh-token sessions
-- Migration: 0033_mobile_session.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0032_lesson_signature.sql must
--               already be applied.
--
-- [VERIFY-4M-SEC-1] PREDECESSOR: replaces the 8h non-revocable mobile
-- bearer token (Slice 4M.1, ADR-0010) with SHORT-LIVED signed access tokens
-- (~15 min, same JWE format/AUTH_SECRET, unchanged verifyMobileToken shape)
-- plus a revocable, rotating refresh-token session recorded here. This is
-- the HARD PREDECESSOR the 4M.1 spec called out before any mobile WRITE
-- slice can be built — it adds NO new write/dispatch surface itself, only
-- instant session revocability for the read-only mobile app.
--
--   mobile_session — one row per issued refresh token (login) or per
--     rotation (refresh). NEVER stores the raw refresh token — only a
--     deterministic hash (sha256; see packages/api/src/auth/mobile-session.ts
--     header for why sha256, not argon2, is the correct choice here).
--     Standard 4-policy (mutable) RLS, mirrors calendar_feed / notification_pref,
--     PLUS the calendar_feed_select precedent: SELECT also admits
--     platform-admin context, because resolveMobileSessionByHash (refresh/
--     logout) must find a row by its hash BEFORE any org context is known
--     (the same justification as resolveFeedByToken / resolveOrgBySlug).
--     Every WRITE (insert at login, rotate/revoke at refresh/logout) happens
--     ONLY inside withOrgContext using the org_id THIS table's own row
--     resolved — never platform-admin — mirrors build-ics-for-feed.ts exactly.
--
-- Key guarantees:
--   (1) Tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS.
--   (2) refresh_token_hash is UNIQUE — the O(1) lookup key. A raw refresh
--       token is a high-entropy (256-bit) random value (node:crypto
--       randomBytes), never a low-entropy secret like a password — so a
--       fast deterministic hash (sha256) is the correct primitive: it
--       enables index equality lookup, and the preimage space is
--       computationally infeasible to search regardless of hash speed.
--       Argon2 (slow, salted, non-deterministic per call) is the RIGHT
--       choice for passwords but the WRONG choice here: its random salt
--       would make an indexed equality lookup impossible without an O(n)
--       scan, and its slowness defends against a threat (offline brute
--       force of a low-entropy secret) that does not apply to a 256-bit
--       random token.
--   (3) rotated_to_id (nullable, self-referencing composite FK) records the
--       rotation chain: when a refresh token is exchanged for a new pair,
--       the OLD row's rotated_to_id is set to the NEW row's id AND its
--       revoked_at is set — the old refresh token can never be used again.
--       If an OLD (already-rotated) refresh token is EVER presented again,
--       that is a THEFT SIGNAL (reuse of a stolen/leaked token) — the
--       command layer (refreshMobileSession) revokes the ENTIRE forward
--       chain from that point (every descendant session), fail-closed, so
--       even the legitimate holder of the newest token is forced to
--       re-authenticate. ON DELETE SET NULL: no cleanup/purge job exists
--       yet for this table (forward seam) — if one is ever added, deleting
--       an old chain link must not be blocked by a newer row's FK.
--   (4) Composite FKs (hand-written; Drizzle cannot express multi-column FKs):
--         (org_id) → org(id) ON DELETE CASCADE.
--         (user_id, org_id) → app_user(id, org_id) ON DELETE CASCADE — a
--           session has no meaning once its user is gone (mirrors
--           notification_pref's user FK, not dues_schedule's RESTRICT: a
--           mobile session is not a durable record, just a live credential).
--         (rotated_to_id, org_id) → mobile_session(id, org_id)
--           ON DELETE SET NULL — nullable, fires only on non-null; the
--           self-referencing rotation-chain pointer. Requires
--           mobile_session_id_org_id_unique (created in this migration).
--   (5) UNIQUE (id, org_id) composite candidate key — consistent with all
--       other tenant tables; also the self-FK target for rotated_to_id.
--   (6) device_label is free-text, operator/device-supplied, OPTIONAL —
--       display-only (e.g. "iPhone 15"), never used as a security boundary.
--   (7) STRICTLY ADDITIVE — no existing tables/columns/constraints modified.
--       Only the one new table is created. The FROZEN dispatch gate,
--       gatedCreateOccurrence, and every other engine are untouched. The
--       WEB NextAuth cookie-session path (auth-config.ts authorize,
--       verifyLoginAndIssueClaims) is untouched — this migration and its
--       consuming code are mobile-only.
--   (8) NO write/dispatch/money surface is added by this migration or the
--       code that consumes it — login/refresh/logout only.
--
-- ORDER within this file:
--   (1) CREATE TABLE mobile_session (FKs + UNIQUEs)
--   (2) Indexes
--   (3) ENABLE + FORCE RLS
--   (4) RLS policies (standard 4-policy + platform-admin SELECT admit)
--   (5) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE mobile_session ─────────────────────────────────────────────────

CREATE TABLE "mobile_session" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"              uuid NOT NULL,
  "user_id"             uuid NOT NULL,
  "refresh_token_hash"  text NOT NULL,
  "device_label"        text,
  "issued_at"           timestamptz NOT NULL DEFAULT now(),
  "expires_at"          timestamptz NOT NULL,
  "last_used_at"        timestamptz,
  "revoked_at"          timestamptz,
  "rotated_to_id"       uuid,

  -- Tenant spine FK.
  CONSTRAINT "mobile_session_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the session's user must be a member of the same org.
  -- ON DELETE CASCADE: a session has no meaning once its user is gone.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "mobile_session_user_org_fk"
    FOREIGN KEY ("user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE CASCADE,

  -- The O(1) lookup key for resolveMobileSessionByHash. Globally unique —
  -- a hash collision across orgs is cryptographically infeasible (sha256).
  CONSTRAINT "mobile_session_refresh_token_hash_unique"
    UNIQUE ("refresh_token_hash"),

  -- Composite candidate key — consistent with all other tenant tables; also
  -- the self-FK target for rotated_to_id (below).
  CONSTRAINT "mobile_session_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Self-referencing composite FK: the rotation-chain pointer. When present,
  -- the rotated-to target must be a session in the same org.
  -- ON DELETE SET NULL: no purge job exists yet (forward seam); a future
  -- purge of an old chain link must not be blocked by this pointer.
  -- Targets mobile_session_id_org_id_unique (above, same table).
  CONSTRAINT "mobile_session_rotated_to_org_fk"
    FOREIGN KEY ("rotated_to_id", "org_id")
    REFERENCES "mobile_session"("id", "org_id") ON DELETE SET NULL,

  CONSTRAINT "mobile_session_refresh_token_hash_nonempty_check" CHECK (
    char_length(btrim("refresh_token_hash")) > 0
  )
);


-- ── (2) Indexes ───────────────────────────────────────────────────────────────

-- Per-user session listing (revokeAllMobileSessionsForUser).
CREATE INDEX "mobile_session_org_user_idx"
  ON "mobile_session" ("org_id", "user_id");

-- refresh_token_hash is already indexed by its UNIQUE constraint above — no
-- separate plain index needed (mirrors calendar_feed_token_unique).


-- ── (3) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "mobile_session" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "mobile_session" FORCE   ROW LEVEL SECURITY;


-- ── (4) RLS policies ──────────────────────────────────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)

-- mobile_session_select ALSO permits platform-admin context (mirrors
-- calendar_feed_select / payment_intent_record_select's EXACT precedent):
-- resolveMobileSessionByHash (packages/api/src/auth/resolve-mobile-session.ts)
-- is the ONE sanctioned platform-admin read in the mobile refresh/logout
-- path — a refresh/logout request carries only an opaque refresh token, no
-- org context, until AFTER this lookup resolves which org+user it belongs
-- to. Normal tenant context (platform_admin not 'on') remains scoped to its
-- own org; every WRITE below stays org-GUC-only.
CREATE POLICY "mobile_session_select"
  ON "mobile_session"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'on'
  );

CREATE POLICY "mobile_session_insert"
  ON "mobile_session"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "mobile_session_update"
  ON "mobile_session"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "mobile_session_delete"
  ON "mobile_session"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (5) GRANT to aeroops_app ───────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "mobile_session" TO aeroops_app;
