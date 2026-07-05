/**
 * onboarding/get-onboarding-status.ts — Derived setup checklist (read-only).
 *
 * getOnboardingStatus(session) inspects what the org has already configured and
 * returns a typed setup checklist. It is a DERIVED read — there is NO onboarding
 * table and NO migration. Each step is computed from an RLS-scoped aggregate over
 * the tables the operator would populate on the real setup surfaces (Fleet,
 * People, base-airport location, billing rates, booking policies, payments).
 *
 * PURPOSE: power a "Set up your operation" page and a dashboard setup banner that
 * scale from a 2-plane flying club to a large academy — essentials front-and-
 * centre, optional depth below.
 *
 * AUTHZ: requireCapability('org:manage_settings') FIRST — setup is an admin task
 *   (owner/manager only). A dispatcher/cfi/etc. is refused (ForbiddenError).
 * TENANT ISOLATION: org_id from session only; every query runs inside
 *   withSessionOrgContextWithDb (RLS GUC set on the tx). No aggregate can read
 *   another org's rows.
 *
 * DESIGN:
 *   - One COUNT query per step — independently org-auditable, no cross-org N+1.
 *   - Zero rows → 0 (COALESCE / COUNT), never null/NaN/throw.
 *   - ESSENTIAL steps (aircraft + people) are the minimum to start scheduling.
 *     OPTIONAL steps (base_airport, rates, policies, payments) add depth for
 *     larger operations but never block the essentials.
 *
 * "people" is done when the org has MORE THAN ONE active member — the sole
 *   seeded owner alone does not count as "invited your team".
 * "base_airport" requires a location with BOTH latitude AND longitude
 *   (the civil-twilight calc needs coords; an ICAO-only base is not enough).
 * "payments" is done when a QBO connection is 'connected' OR a Stripe customer
 *   record exists for the org — otherwise false (no external call is made).
 *
 * TWO CALLING FORMS:
 *   getOnboardingStatus(session)          — app code.
 *   getOnboardingStatusWithDb(db, session) — tests.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { extractRows } from '../db-rows.js';

// ─── Output types ─────────────────────────────────────────────────────────────

/** Stable key for each setup step (used for links + copy on the web page). */
export type OnboardingStepKey =
  | 'aircraft'
  | 'people'
  | 'base_airport'
  | 'rates'
  | 'policies'
  | 'payments';

export interface OnboardingStep {
  /** Stable step identifier. */
  key: OnboardingStepKey;
  /** Whether this step's configuration exists yet. */
  done: boolean;
  /**
   * ESSENTIAL steps (aircraft + people) are the minimum to start scheduling.
   * OPTIONAL steps add depth but never block scheduling.
   */
  essential: boolean;
  /**
   * How many of the relevant records exist (aircraft/members/rates/policies),
   * the count of coord-bearing base locations, or the count of configured
   * payment providers. Always a number ≥ 0 (never null/NaN).
   */
  count: number;
}

export interface OnboardingStatus {
  /** The full ordered checklist (essentials first). */
  steps: OnboardingStep[];
  /** True once BOTH essentials (aircraft + people) are done — you can schedule. */
  essentialDone: boolean;
  /** True once every OPTIONAL step is done. */
  optionalDone: boolean;
  /** Count of essential steps done (0..essentialTotal). */
  essentialCount: number;
  /** Total essential steps (2). */
  essentialTotal: number;
  /** Count of ALL steps done (essential + optional). */
  doneCount: number;
  /** Total steps (essential + optional). */
  totalCount: number;
  /** doneCount / totalCount as a whole-number percent (0..100). */
  percentComplete: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getOnboardingStatusImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<OnboardingStatus> {
  // 1. AUTHZ FIRST — setup is an admin task (owner/manager).
  requireCapability(session, 'org:manage_settings');

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // ── Aircraft: active aircraft in the fleet (ESSENTIAL) ────────────────────
    const aircraftResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM resource
      WHERE kind = 'aircraft'
        AND active = true
    `);
    const aircraftCount = Number(
      extractRows<{ count: number | string }>(aircraftResult)[0]?.count ?? 0,
    );

    // ── People: active members on the roster (ESSENTIAL) ──────────────────────
    // "done" requires MORE THAN ONE — the sole owner alone is not a team yet.
    const memberResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM app_user
      WHERE status = 'active'
    `);
    const memberCount = Number(
      extractRows<{ count: number | string }>(memberResult)[0]?.count ?? 0,
    );

    // ── Base airport: a location with BOTH coords (OPTIONAL) ──────────────────
    const baseResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM location
      WHERE latitude IS NOT NULL
        AND longitude IS NOT NULL
    `);
    const baseCoordsCount = Number(
      extractRows<{ count: number | string }>(baseResult)[0]?.count ?? 0,
    );

    // ── Rates: operator-defined billing rate schedules (OPTIONAL) ─────────────
    const rateResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM rate_schedule
    `);
    const rateCount = Number(
      extractRows<{ count: number | string }>(rateResult)[0]?.count ?? 0,
    );

    // ── Policies: per-resource booking policies (OPTIONAL) ────────────────────
    const policyResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM booking_policy
    `);
    const policyCount = Number(
      extractRows<{ count: number | string }>(policyResult)[0]?.count ?? 0,
    );

    // ── Payments: QBO connected OR a Stripe customer exists (OPTIONAL) ────────
    // No external call — purely inspects the org's own connection records.
    const qboResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM qbo_connection
      WHERE status = 'connected'
    `);
    const qboConnectedCount = Number(
      extractRows<{ count: number | string }>(qboResult)[0]?.count ?? 0,
    );

    const stripeResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS "count"
      FROM stripe_customer
    `);
    const stripeCount = Number(
      extractRows<{ count: number | string }>(stripeResult)[0]?.count ?? 0,
    );

    // Count of configured payment providers (0, 1, or 2).
    const paymentsProviderCount =
      (qboConnectedCount > 0 ? 1 : 0) + (stripeCount > 0 ? 1 : 0);

    // ── Assemble the ordered checklist ────────────────────────────────────────
    const steps: OnboardingStep[] = [
      { key: 'aircraft', done: aircraftCount > 0, essential: true, count: aircraftCount },
      // >1: the sole seeded owner alone is not "invited your team".
      { key: 'people', done: memberCount > 1, essential: true, count: memberCount },
      { key: 'base_airport', done: baseCoordsCount > 0, essential: false, count: baseCoordsCount },
      { key: 'rates', done: rateCount > 0, essential: false, count: rateCount },
      { key: 'policies', done: policyCount > 0, essential: false, count: policyCount },
      { key: 'payments', done: paymentsProviderCount > 0, essential: false, count: paymentsProviderCount },
    ];

    const essentialSteps = steps.filter((s) => s.essential);
    const optionalSteps = steps.filter((s) => !s.essential);

    const essentialCount = essentialSteps.filter((s) => s.done).length;
    const essentialTotal = essentialSteps.length;
    const essentialDone = essentialCount === essentialTotal;
    const optionalDone = optionalSteps.every((s) => s.done);

    const doneCount = steps.filter((s) => s.done).length;
    const totalCount = steps.length;
    const percentComplete =
      totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * 100);

    return {
      steps,
      essentialDone,
      optionalDone,
      essentialCount,
      essentialTotal,
      doneCount,
      totalCount,
      percentComplete,
    };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * getOnboardingStatus — derived setup checklist for the session org.
 *
 * Uses the memoized production DB client (getDb()). apps/web never passes a db.
 *
 * @param session - AppSession from auth(); throws UnauthenticatedError if null.
 * @returns OnboardingStatus
 * @throws UnauthenticatedError, ForbiddenError
 */
export async function getOnboardingStatus(
  session: AppSession | null | undefined,
): Promise<OnboardingStatus> {
  const db = await getDb();
  return _getOnboardingStatusImpl(db, session);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/**
 * getOnboardingStatusWithDb — same contract but accepts an explicit db.
 *
 * Tests MUST use this form so they never trigger getDb().
 */
export async function getOnboardingStatusWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<OnboardingStatus> {
  return _getOnboardingStatusImpl(db, session);
}
