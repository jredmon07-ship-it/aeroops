/**
 * preview-auto-schedule.ts — previewAutoSchedule: advisory read-only preview of
 * what runAutoSchedule would produce. (Slice 4b §4b.2)
 *
 * GUARANTEES (mirrors previewSeries):
 *   - authz: requireCapability('schedule:create_reservation') — same gate as the
 *     commit it previews.
 *   - PURE PREVIEW: no INSERT/UPDATE/DELETE, no audit row, no run header.
 *   - `now`/`seed` injectable so the preview is deterministic + agrees with a
 *     subsequent runAutoSchedule (same input + seed, absent concurrent writes).
 *   - Builds the SAME availability + twilight boundaries as the commit path, runs
 *     the PURE proposeSchedule, then PROBES each proposal (conflict probe + policy
 *     probe + twilight gate) WITHOUT writing.
 *
 * The probe mirrors gatedCreateOccurrence's refusal precedence so wouldResult
 * agrees with the commit:
 *   conflict_and_policy > policy > conflict > twilight(block only) > create.
 * Twilight in warn/disabled mode is INERT here (it would create with a warning at
 * commit, not skip) — consistent with the write path.
 *
 * NOT A WRITE GATE: advisory only. The authoritative gate is runAutoSchedule.
 *
 * TWO CALLING FORMS:
 *   previewAutoSchedule(session, input)                  — app code.
 *   previewAutoScheduleWithDb(db, session, input, opts?) — tests; inject pglite.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { proposeSchedule, evaluateTwilightGate } from '@aeroops/core';
import type { TwilightHit } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import {
  runConflictProbe,
  runPolicyProbe,
  loadTwilightContext,
} from './internal.js';
import {
  validateAutoScheduleInput,
  buildAvailability,
  buildTwilightBoundaries,
  deriveSeed,
} from './auto-schedule-internal.js';
import type {
  PreviewAutoScheduleResult,
  PreviewAutoProposalReport,
} from './types.js';

interface PreviewAutoScheduleOptions {
  now?: number;
  seed?: number;
}

async function _previewAutoScheduleImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  opts?: PreviewAutoScheduleOptions,
): Promise<PreviewAutoScheduleResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'schedule:create_reservation');

  // 2. VALIDATE.
  const norm = validateAutoScheduleInput(input);

  // 3. Capture now + seed ONCE (default seed = pure hash of input).
  const now = opts?.now ?? Date.now();
  const seed = opts?.seed ?? deriveSeed(norm);

  // 4. Read-only build + propose + probe.
  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const availability = await buildAvailability(tx, norm.allResourceIds, norm.base);
    const { boundaries, config } = await buildTwilightBoundaries(
      tx,
      sess.orgId,
      norm.allResourceIds,
      norm.base.start,
    );

    const { proposals: proposed, unschedulable } = proposeSchedule({
      demands: norm.demands,
      availability,
      twilightBoundaries: boundaries,
      objective: norm.objective,
      seed,
      now,
    });

    // Load resource displayNames once for the policy probe enrichment.
    let resourceMeta: Array<{ id: string; displayName: string }> = [];
    if (norm.allResourceIds.length > 0) {
      const idList = sql.join(
        norm.allResourceIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const rows = await tx.execute(sql`
        SELECT id, display_name AS display_name
        FROM resource
        WHERE id = ANY(ARRAY[${idList}])
      `);
      const raw = (rows.rows ?? rows) as Array<{ id: string; display_name: string }>;
      resourceMeta = raw.map((r) => ({ id: r.id, displayName: r.display_name }));
    }
    const metaById = new Map(resourceMeta.map((m) => [m.id, m]));

    const reports: PreviewAutoProposalReport[] = [];
    let wouldCreateCount = 0;
    let wouldSkipCount = 0;

    for (const p of proposed) {
      const startAt = new Date(p.startUtcMs);
      const endAt = new Date(p.endUtcMs);
      const resourceIds = p.resourceIds;
      const metaForProposal = resourceIds
        .map((id) => metaById.get(id))
        .filter((m): m is { id: string; displayName: string } => m != null);

      const [hits, violations] = await Promise.all([
        runConflictProbe(tx, startAt, endAt, resourceIds),
        runPolicyProbe(tx, startAt, endAt, metaForProposal, now),
      ]);

      // Refusal precedence (mirrors gatedCreateOccurrence). Twilight only in block mode.
      if (hits.length > 0 || violations.length > 0) {
        wouldSkipCount++;
        reports.push({
          demandId: p.demandId,
          startAt,
          endAt,
          resourceIds,
          wouldResult: 'skip',
          reason:
            hits.length > 0 && violations.length > 0
              ? 'conflict_and_policy'
              : hits.length > 0
                ? 'conflict'
                : 'policy',
          ...(hits.length > 0 ? { conflicts: hits } : {}),
          ...(violations.length > 0 ? { violations } : {}),
        });
        continue;
      }

      // Twilight probe (block mode only — matches the write path; warn/disabled
      // would create with a warning, not skip).
      if (config.enabled && config.mode === 'block') {
        const ctx = await loadTwilightContext(tx, sess.orgId, resourceIds, startAt.getTime(), config);
        const blocked: TwilightHit[] = [];
        for (const r of ctx.perResource) {
          const res = evaluateTwilightGate({
            candidateStartUtcMs: startAt.getTime(),
            candidateEndUtcMs: endAt.getTime(),
            events: r.events,
            pilotIsExempt: ctx.pilotIsExempt,
            mode: 'block',
          });
          blocked.push(...res.blocked);
        }
        if (blocked.length > 0) {
          wouldSkipCount++;
          reports.push({
            demandId: p.demandId,
            startAt,
            endAt,
            resourceIds,
            wouldResult: 'skip',
            reason: 'twilight',
            twilight: blocked,
          });
          continue;
        }
      }

      wouldCreateCount++;
      reports.push({
        demandId: p.demandId,
        startAt,
        endAt,
        resourceIds,
        wouldResult: 'create',
      });
    }

    return {
      proposals: reports,
      unschedulable,
      wouldCreateCount,
      wouldSkipCount,
    };
  });
}

/**
 * previewAutoSchedule — advisory preview of what runAutoSchedule would produce.
 * Writes nothing; never the sole write guard.
 *
 * @param session - AppSession; null/undefined → UnauthenticatedError.
 * @param input   - AutoScheduleInput (same shape as runAutoSchedule).
 * @throws  UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function previewAutoSchedule(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<PreviewAutoScheduleResult> {
  const db = await getDb();
  return _previewAutoScheduleImpl(db, session, input);
}

/** previewAutoScheduleWithDb — test form; inject a pglite client + now/seed. */
export async function previewAutoScheduleWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  opts?: PreviewAutoScheduleOptions,
): Promise<PreviewAutoScheduleResult> {
  return _previewAutoScheduleImpl(db, session, input, opts);
}
