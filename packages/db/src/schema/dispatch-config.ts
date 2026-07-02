/**
 * dispatch_config — per-org dispatch gate configuration (0..1 row per org).
 *
 * Controls gate dimensions at check-out:
 *   eligibility_mode: whether a missing required tag BLOCKS or WARNS.
 *   balance_check_enabled: feature flag for the future balance seam.
 *
 * [VERIFY-3c-MONEY] (HARD MONEY BOUNDARY): balance_check_enabled is a
 * FEATURE FLAG ONLY. It controls whether the balance-seam stub is invoked.
 * There is NO dollar value, minimum balance, payment reference, Stripe
 * integration, or financial data anywhere in this table. The balance seam
 * always returns {ok:true} in Phase 1 — this flag is wired but inert.
 * Billing / real balance enforcement is Phase 2. UI copy must say
 * "Not yet active — turning this on has no effect until account balances ship."
 *
 * Civil-twilight scheduling constraint (Slice 4a, migration 0010):
 *   twilight_constraint_enabled: operator opt-in (default false → gate inert).
 *   twilight_mode: 'warn' (default) or 'block'. CHECK in migration 0010.
 *   twilight_exempt_tag: FREE-TEXT operator label — if set, a pilot holding
 *     this tag is exempted from the twilight gate. Exemption wiring DEFERRED
 *     in 4a (pilotIsExempt=false always); column is a forward seam.
 *     [VERIFY-4a-A/D]: civil twilight = astronomy + operator config ONLY.
 *     The system computes NO FAA night-currency (§61.57/§1.1) determination.
 *     "Night-qualified" is a free-text label; no regulatory meaning is attached.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0009).
 *
 * UNIQUE (org_id): one config row per org (0..1). Absent row → defaults apply:
 *   { eligibilityMode: 'block', balanceCheckEnabled: false,
 *     twilightConstraintEnabled: false, twilightMode: 'warn', twilightExemptTag: null,
 *     availabilityConstraintEnabled: false, availabilityMode: 'warn',
 *     bookingRequestRetentionDays: 365, bookingRequestRetentionIncludesConverted: false }
 *
 * ── UNIQUEs ───────────────────────────────────────────────────────────────────
 * dispatch_config_org_id_unique UNIQUE (org_id)
 *   One config per org. Used as the ON CONFLICT target in upsert.
 *
 * dispatch_config_id_org_id_unique UNIQUE (id, org_id)
 *   Composite candidate key — forward-compat for future composite FKs,
 *   consistent with all other tenant tables.
 *
 * ── CHECKs (hand-written in migration SQL) ───────────────────────────────────
 * dispatch_config_eligibility_mode_check (migration 0009):
 *   eligibility_mode IN ('block', 'warn')
 * dispatch_config_twilight_mode_check (migration 0010):
 *   twilight_mode IN ('block', 'warn')
 * dispatch_config_twilight_exempt_tag_nonempty_check (migration 0010):
 *   twilight_exempt_tag IS NULL OR char_length(btrim(twilight_exempt_tag)) > 0
 * dispatch_config_booking_retention_days_check (migration 0017):
 *   booking_request_retention_days >= 0 AND booking_request_retention_days <= 3650
 *   (0 = retention disabled / keep-forever; 3650 ≈ 10 years; NOT delete-all)
 *
 * Availability scheduling constraint (Slice AV1.1, migration 0014):
 *   availability_constraint_enabled: operator opt-in (default false → gate inert).
 *   availability_mode: 'warn' (default) or 'block'. CHECK in migration 0014.
 *   [VERIFY-AV1-A]: availability windows = OPERATOR scheduling/operating-hours data ONLY.
 *   The system computes NO FAA duty-time, rest-period, Part-117/135/121 determination.
 *   These are the times the operator has decided to make a resource available for
 *   scheduling — nothing more. Compliance confirms at QA.
 *
 * Balance minimum threshold (Slice B2, migration 0022):
 *   minimum_balance_cents: operator-set integer-cents threshold. DATA ONLY —
 *   consumed EXCLUSIVELY by packages/api/src/billing/real-balance-seam.ts
 *   (realBalanceSeam), which is NOT injected into openDispatch()'s app-code
 *   form in Slice B2/B3-foundation (the FROZEN gate keeps calling
 *   stubBalanceSeam, always {ok:true}, regardless of this value or of
 *   balance_check_enabled). Default 0. [VERIFY-B2-MONEY]: adding/reading this
 *   column changes NO dispatch gate behaviour by itself — see migration 0022
 *   header for the full boundary rationale.
 */
import {
  pgTable,
  uuid,
  timestamp,
  text,
  boolean,
  integer,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const dispatchConfig = pgTable(
  'dispatch_config',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — simple FK; named FK dispatch_config_org_id_fk
    // with ON DELETE CASCADE is hand-written in migration 0009.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // 'block' | 'warn'. DEFAULT 'block' ensures a missing required tag blocks
    // dispatch when a rule exists. CHECK hand-written in migration 0009.
    eligibilityMode: text('eligibility_mode').notNull().default('block'),

    // FEATURE FLAG — Phase 1 stub only. [VERIFY-3c-MONEY]: no money concept.
    // false = balance seam not invoked. true = stub still returns {ok:true}.
    balanceCheckEnabled: boolean('balance_check_enabled').notNull().default(false),

    // Civil-twilight gate (Slice 4a, migration 0010).
    // [VERIFY-4a-A/D]: astronomy + operator config ONLY — not an FAA night-currency
    // or §61.57/§1.1 determination. twilight_mode CHECK in migration 0010.
    twilightConstraintEnabled: boolean('twilight_constraint_enabled').notNull().default(false),

    // 'warn' (default) | 'block'. CHECK (twilight_mode IN ('block','warn')) in migration 0010.
    twilightMode: text('twilight_mode').notNull().default('warn'),

    // FREE-TEXT operator label; exemption wiring DEFERRED (4a ships pilotIsExempt=false always).
    // CHECK: NULL OR char_length(btrim(.)) > 0  — in migration 0010.
    twilightExemptTag: text('twilight_exempt_tag'),

    // Availability scheduling gate (Slice AV1.1, migration 0014).
    // [VERIFY-AV1-A]: operator operating-hours data ONLY — NOT an FAA duty/rest/Part-117
    // determination. availabilityMode CHECK in migration 0014.
    availabilityConstraintEnabled: boolean('availability_constraint_enabled').notNull().default(false),

    // 'warn' (default) | 'block'. CHECK (availability_mode IN ('block','warn')) in migration 0014.
    availabilityMode: text('availability_mode').notNull().default('warn'),

    // Booking-request PII retention config (Slice PB-LR.A, migration 0017).
    // bookingRequestRetentionDays: 0 = keep forever (retention disabled — NOT delete-all).
    //   Range: 0–3650 (CHECK in migration 0017). Default 365.
    //   Absent row → application-layer default {365, false} (same as DB DEFAULT).
    bookingRequestRetentionDays: integer('booking_request_retention_days').notNull().default(365),

    // When false (default): purge excludes 'converted' rows (they represent confirmed
    //   customer relationships; typically retained longer than speculative leads).
    // When true: the retention window also applies to 'converted' rows.
    bookingRequestRetentionIncludesConverted: boolean('booking_request_retention_includes_converted').notNull().default(false),

    // Balance minimum threshold (Slice B2, migration 0022). DATA ONLY — see
    // file-level comment. CHECK (minimum_balance_cents >= 0) in migration 0022.
    minimumBalanceCents: integer('minimum_balance_cents').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One config row per org — target for ON CONFLICT(org_id) upsert.
    uniqueIndex('dispatch_config_org_id_unique').on(t.orgId),

    // Composite candidate key — forward-compat for future composite FKs.
    // Consistent with all other tenant tables.
    uniqueIndex('dispatch_config_id_org_id_unique').on(t.id, t.orgId),
  ],
);

export type DispatchConfigSelect = typeof dispatchConfig.$inferSelect;
export type DispatchConfigInsert = typeof dispatchConfig.$inferInsert;
