-- ============================================================
-- AeroOps — Slice 4a: Civil-twilight location coordinates + dispatch_config twilight fields
-- Migration: 0010_civil_twilight.sql
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
--               must already be applied.
--
-- PURELY ADDITIVE — no new tables, no new RLS blocks:
--   Both `location` and `dispatch_config` already have ENABLE + FORCE RLS
--   with 4 named policies each (migrations 0000 and 0009 respectively).
--   New columns inherit the existing RLS predicates automatically.
--   No new grants needed: aeroops_app already has full DML on both tables.
--
-- Adds the Slice 4a (civil-twilight) data-model delta:
--   (1) location.latitude  numeric(8,5) NULL — WGS84 decimal degrees
--   (2) location.longitude numeric(8,5) NULL — WGS84 decimal degrees
--   (3) civil_twilight_lat_range_check    CHECK (lat  NULL OR BETWEEN -90  AND  90)
--   (4) civil_twilight_lon_range_check    CHECK (lon  NULL OR BETWEEN -180 AND 180)
--   (5) civil_twilight_latlon_paired_check CHECK ((latitude IS NULL) = (longitude IS NULL))
--   (6) dispatch_config.twilight_constraint_enabled boolean NOT NULL DEFAULT false
--   (7) dispatch_config.twilight_mode              text    NOT NULL DEFAULT 'warn'
--   (8) dispatch_config.twilight_exempt_tag        text    NULL
--   (9) dispatch_config_twilight_mode_check        CHECK (twilight_mode IN ('block','warn'))
--  (10) dispatch_config_twilight_exempt_tag_nonempty_check
--         CHECK (twilight_exempt_tag IS NULL OR char_length(btrim(twilight_exempt_tag)) > 0)
--
-- [VERIFY-4a-A] (HARD COMPLIANCE LINE): civil twilight = ASTRONOMY + operator config
--   ONLY. The -6° civil / -0.833° sunrise-sunset constants are standard astronomy
--   (NOAA/Meeus). The system computes NO FAA night-currency (§61.57/§1.1/§1.1)
--   determination whatsoever. Operator config block/warn is the operator enforcing
--   their own scheduling rule, not a regulatory determination.
--
-- [VERIFY-4a-D]: twilight_exempt_tag is a FREE-TEXT operator label ONLY.
--   "Night-qualified" is a label the operator assigns; the system attaches NO
--   regulatory meaning. Exemption wiring is DEFERRED in Slice 4a
--   (pilotIsExempt=false always in the 4a gate); this column is a forward seam.
--   UI copy MUST carry: "This is an operator scheduling rule based on astronomical
--   civil-twilight times. It is NOT an FAA night-currency or §61.57 determination.
--   'Night-qualified' is a label you assign; the system attaches no regulatory meaning."
--
-- Key guarantees:
--   (1) All new columns are nullable (or NOT NULL with a safe DEFAULT) — existing
--       rows and existing INSERT statements that omit the new columns succeed unchanged.
--   (2) Paired-presence check (lat/lon): both NULL or both set; half-set rejected.
--   (3) Range checks prevent geographically-impossible coordinates.
--   (4) Absent dispatch_config row → caller applies defaults:
--         { twilightConstraintEnabled: false, twilightMode: 'warn', twilightExemptTag: null }
--       Defaults mean the gate is INERT until the operator deliberately turns it on.
--   (5) No new RLS, no new grants — inherited from existing table policies.
--   (6) No existing behaviour is altered by this migration.
--
-- ORDER:
--   (1) ALTER TABLE location ADD COLUMN latitude
--   (2) ALTER TABLE location ADD COLUMN longitude
--   (3) ALTER TABLE location ADD CONSTRAINT civil_twilight_lat_range_check
--   (4) ALTER TABLE location ADD CONSTRAINT civil_twilight_lon_range_check
--   (5) ALTER TABLE location ADD CONSTRAINT civil_twilight_latlon_paired_check
--   (6) ALTER TABLE dispatch_config ADD COLUMN twilight_constraint_enabled
--   (7) ALTER TABLE dispatch_config ADD COLUMN twilight_mode
--   (8) ALTER TABLE dispatch_config ADD COLUMN twilight_exempt_tag
--   (9) ALTER TABLE dispatch_config ADD CONSTRAINT dispatch_config_twilight_mode_check
--  (10) ALTER TABLE dispatch_config ADD CONSTRAINT dispatch_config_twilight_exempt_tag_nonempty_check
-- ============================================================


-- ── (1) Add latitude to location ─────────────────────────────────────────────
-- WGS84 decimal degrees. Nullable: existing rows are unaffected.
-- Valid range: -90..90. Paired with longitude — both must be set or both NULL.

ALTER TABLE "location" ADD COLUMN "latitude" numeric(8,5);


-- ── (2) Add longitude to location ────────────────────────────────────────────
-- WGS84 decimal degrees. Nullable: existing rows are unaffected.
-- Valid range: -180..180. Paired with latitude.

ALTER TABLE "location" ADD COLUMN "longitude" numeric(8,5);


-- ── (3) Latitude range check ──────────────────────────────────────────────────
-- NULL is allowed (column is optional). Non-null values must be in [-90, 90].

ALTER TABLE "location"
  ADD CONSTRAINT "civil_twilight_lat_range_check"
  CHECK ("latitude" IS NULL OR ("latitude" BETWEEN -90 AND 90));


-- ── (4) Longitude range check ─────────────────────────────────────────────────
-- NULL is allowed. Non-null values must be in [-180, 180].

ALTER TABLE "location"
  ADD CONSTRAINT "civil_twilight_lon_range_check"
  CHECK ("longitude" IS NULL OR ("longitude" BETWEEN -180 AND 180));


-- ── (5) Paired-presence check (lat/lon must be both-null or both-set) ─────────
-- Rejects a half-set coordinate (latitude set but longitude NULL, or vice versa).
-- The civil-twilight calculation requires both values; a single coordinate
-- carries no usable astronomical meaning.

ALTER TABLE "location"
  ADD CONSTRAINT "civil_twilight_latlon_paired_check"
  CHECK (("latitude" IS NULL) = ("longitude" IS NULL));


-- ── (6) Add twilight_constraint_enabled to dispatch_config ───────────────────
-- Operator opt-in flag. Default false → gate is INERT until deliberately enabled.
-- NOT NULL with DEFAULT false: existing rows receive false silently (no UPDATE needed).

ALTER TABLE "dispatch_config"
  ADD COLUMN "twilight_constraint_enabled" boolean NOT NULL DEFAULT false;


-- ── (7) Add twilight_mode to dispatch_config ──────────────────────────────────
-- 'warn' (default) | 'block'. CHECK in step (9).
-- Default 'warn' → if the operator enables the gate without choosing a mode,
-- the system warns rather than hard-blocks (fail-open for scheduling continuity).

ALTER TABLE "dispatch_config"
  ADD COLUMN "twilight_mode" text NOT NULL DEFAULT 'warn';


-- ── (8) Add twilight_exempt_tag to dispatch_config ───────────────────────────
-- FREE-TEXT operator label (forward seam — exemption wiring DEFERRED in 4a).
-- [VERIFY-4a-D]: no FAA/regulatory meaning. CHECK in step (10).
-- Nullable: absence means no exemption tag is configured.

ALTER TABLE "dispatch_config"
  ADD COLUMN "twilight_exempt_tag" text;


-- ── (9) twilight_mode domain check ───────────────────────────────────────────
-- Only 'block' and 'warn' are valid mode values. Prevents unknown modes.

ALTER TABLE "dispatch_config"
  ADD CONSTRAINT "dispatch_config_twilight_mode_check"
  CHECK ("twilight_mode" IN ('block', 'warn'));


-- ── (10) twilight_exempt_tag nonempty check ───────────────────────────────────
-- NULL is allowed (no exemption tag configured). Non-null values must not be
-- blank or whitespace-only. UI must trim before sending.

ALTER TABLE "dispatch_config"
  ADD CONSTRAINT "dispatch_config_twilight_exempt_tag_nonempty_check"
  CHECK ("twilight_exempt_tag" IS NULL OR char_length(btrim("twilight_exempt_tag")) > 0);
