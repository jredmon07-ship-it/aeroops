/**
 * auto-schedule.ts — runAutoSchedule: orchestrate the pure optimizer PROPOSER
 * through the FROZEN single write path. (Slice 4b §4b.2)
 *
 * STRUCTURALLY IDENTICAL TO createSeries (the template):
 *   - authz FIRST: requireCapability('schedule:create_reservation').
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - `now` + `seed` captured ONCE at entry (injectable via opts for deterministic
 *     tests; the default seed is a pure hash of the input — NO Date.now/Math.random
 *     in the function body).
 *   - Build availability (operator business-hours base span MINUS existing booked
 *     rows / blackouts / grounded aircraft, RLS-scoped) + twilightBoundaries (4a,
 *     block-mode only) INSIDE the tx, then call the PURE proposeSchedule.
 *   - ONE outer tx; per-proposal SAVEPOINT via tx.transaction(); each proposal goes
 *     through gatedCreateOccurrence (the SINGLE sanctioned write path — NO bespoke
 *     INSERT). A proposal refused by conflict/policy/twilight, or losing a 23P01
 *     race, is reported `skipped` with its reason via the SAME OccurrenceRaceError →
 *     ROLLBACK-TO-SAVEPOINT → re-probe-on-clean-parent-tx loop as createSeries.
 *   - Write ONE schedule_optimization_run row; tag each created reservation's audit
 *     row with metadata.optimizationRunId (done inside gatedCreateOccurrence via the
 *     injected per-occurrence metadata — see the auditMetadata wiring below).
 *
 * ALWAYS ok:true — partial-create is normal; only auth/validation throw.
 * NO money: schedules time only, never prices ([VERIFY-4b-A]).
 *
 * TWO CALLING FORMS:
 *   runAutoSchedule(session, input)                  — app code.
 *   runAutoScheduleWithDb(db, session, input, opts?) — tests; inject pglite.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { scheduleOptimizationRun, auditLog } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { proposeSchedule } from '@aeroops/core';
import {
  OccurrenceRaceError,
  gatedCreateOccurrence,
  runConflictProbe,
} from './internal.js';
import {
  validateAutoScheduleInput,
  buildAvailability,
  buildTwilightBoundaries,
  applyAvailabilityWindows,
  deriveSeed,
} from './auto-schedule-internal.js';
import type {
  AutoScheduleResult,
  AutoProposalReport,
  CreateReservationResult,
} from './types.js';

interface AutoScheduleOptions {
  /** Injected epoch ms — for deterministic tests. Defaults to Date.now(). */
  now?: number;
  /** Injected integer seed — for deterministic tests. Default = deriveSeed(input). */
  seed?: number;
}

async function _runAutoScheduleImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  opts?: AutoScheduleOptions,
): Promise<AutoScheduleResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'schedule:create_reservation');

  // 2. VALIDATE. Throws ValidationError on any malformed field.
  const norm = validateAutoScheduleInput(input);

  // 3. Capture now + seed ONCE. The seed default is a pure hash of the input — no
  //    Date.now/Math.random in this body. Shared across the whole run.
  const now = opts?.now ?? Date.now();
  const seed = opts?.seed ?? deriveSeed(norm);

  // 4. ONE outer tx: build inputs (RLS-scoped reads) → propose (pure) → commit.
  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 4a. Build availability + twilight boundaries (RLS-scoped). The civil day is
    //     anchored at the base-window start so all proposals share one day's dawn/dusk.
    const availability = await buildAvailability(tx, norm.allResourceIds, norm.base);
    const { boundaries } = await buildTwilightBoundaries(
      tx,
      sess.orgId,
      norm.allResourceIds,
      norm.base.start,
    );
    // AV1.2 (block-mode only): intersect the bookable windows with each resource's
    // operating-hours windows so the proposer never proposes outside operating hours.
    // No-op in warn / disabled (the authoritative behaviour lives in gatedCreateOccurrence).
    const { windows: constrainedAvailability } = await applyAvailabilityWindows(
      tx,
      sess.orgId,
      norm.allResourceIds,
      norm.base,
      availability,
    );

    // 4b. PURE proposer. Self-consistent set; NOT the authoritative gate.
    const { proposals: proposed, unschedulable } = proposeSchedule({
      demands: norm.demands,
      availability: constrainedAvailability,
      twilightBoundaries: boundaries,
      objective: norm.objective,
      seed,
      now,
    });

    // 4c. INSERT the run header FIRST (so its id can tag each reservation audit row).
    //     Counts are updated at the end via the running tallies.
    const runRows = await tx
      .insert(scheduleOptimizationRun)
      .values({
        orgId: sess.orgId,
        requestedBy: sess.userId,
        inputJsonb: {
          windowStartUtcMs: norm.base.start,
          windowEndUtcMs: norm.base.end,
          objective: norm.objective,
          demands: norm.demands,
        },
        seed,
        createdCount: 0,
        skippedCount: 0,
      })
      .returning({ id: scheduleOptimizationRun.id });
    const runId = runRows[0]!.id;

    // 4d. Per-proposal: gatedCreateOccurrence inside a SAVEPOINT. A skip rolls back
    //     only its savepoint; the outer tx stays alive and commits the rest. This is
    //     BYTE-FOR-BYTE the createSeries race loop (ADR-0006 §3) — the ONLY change is
    //     the per-occurrence audit metadata carries metadata.optimizationRunId.
    const reports: AutoProposalReport[] = [];
    let createdCount = 0;
    let skippedCount = 0;

    for (const p of proposed) {
      const startAt = new Date(p.startUtcMs);
      const endAt = new Date(p.endUtcMs);
      const resourceIds = p.resourceIds;

      let result: CreateReservationResult | null = null;
      try {
        result = await (tx as AnyDb).transaction(async (sp: AnyDb) => {
          return gatedCreateOccurrence(
            sp,
            sess,
            db,
            { startAt, endAt, resourceIds, auditMetadata: { optimizationRunId: runId } },
            now,
          );
        });
      } catch (err) {
        if (err instanceof OccurrenceRaceError) {
          // Drizzle has rolled back the savepoint; re-probe on the now-clean
          // parent tx to build a rich ConflictHit (the winning row is visible here).
          const hits = await runConflictProbe(tx, startAt, endAt, resourceIds);
          skippedCount++;
          reports.push({
            demandId: p.demandId,
            startAt,
            endAt,
            resourceIds,
            result: 'skipped',
            reason: 'conflict',
            conflicts: hits,
          });
          continue;
        }
        // ValidationError (e.g. a resource id that is not bookable) and any other
        // error propagate as a whole-request failure.
        throw err;
      }

      if (result!.ok) {
        createdCount++;
        reports.push({
          demandId: p.demandId,
          startAt,
          endAt,
          resourceIds,
          result: 'created',
          reservationId: result!.reservation.id,
          ...(result!.groundingWarnings ? { groundingWarnings: result!.groundingWarnings } : {}),
          ...(result!.twilightWarnings ? { twilightWarnings: result!.twilightWarnings } : {}),
          ...(result!.availabilityWarnings ? { availabilityWarnings: result!.availabilityWarnings } : {}),
        });
      } else {
        skippedCount++;
        reports.push({
          demandId: p.demandId,
          startAt,
          endAt,
          resourceIds,
          result: 'skipped',
          reason: result!.reason,
          ...(result!.reason === 'conflict' || result!.reason === 'conflict_and_policy'
            ? { conflicts: result!.conflicts }
            : {}),
          ...(result!.reason === 'policy' || result!.reason === 'conflict_and_policy'
            ? { violations: result!.violations }
            : {}),
          ...(result!.reason === 'twilight' ? { twilight: result!.twilight } : {}),
          ...(result!.reason === 'availability' ? { availability: result!.availability } : {}),
        });
      }
    }

    // 4e. Persist the final counts on the run header (same outer tx).
    await tx
      .update(scheduleOptimizationRun)
      .set({ createdCount, skippedCount })
      .where(sql`${scheduleOptimizationRun.id} = ${runId}::uuid`);

    // 4f. Audit the run header itself (one audit row per run, alongside the
    //     per-reservation reservation.created rows tagged with optimizationRunId).
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'optimization_run.created',
      entityType: 'schedule_optimization_run',
      entityId: runId,
      metadata: {
        objective: norm.objective,
        windowStartUtcMs: norm.base.start,
        windowEndUtcMs: norm.base.end,
        demandCount: norm.demands.length,
        proposedCount: proposed.length,
        createdCount,
        skippedCount,
        unschedulableCount: unschedulable.length,
        seed,
      },
    });

    return {
      ok: true as const,
      runId,
      proposals: reports,
      unschedulable,
      createdCount,
      skippedCount,
    };
  });
}

/**
 * runAutoSchedule — auto-schedule a demand set for the authenticated org, routing
 * every proposal through the FROZEN gatedCreateOccurrence. Always ok:true (partial-
 * create is normal); auth/validation throw.
 *
 * @param session - AppSession; null/undefined → UnauthenticatedError.
 * @param input   - AutoScheduleInput (Zod-equivalent validation here too).
 * @throws  UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function runAutoSchedule(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<AutoScheduleResult> {
  const db = await getDb();
  return _runAutoScheduleImpl(db, session, input);
}

/** runAutoScheduleWithDb — test form; inject a pglite client + now/seed. */
export async function runAutoScheduleWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  opts?: AutoScheduleOptions,
): Promise<AutoScheduleResult> {
  return _runAutoScheduleImpl(db, session, input, opts);
}
