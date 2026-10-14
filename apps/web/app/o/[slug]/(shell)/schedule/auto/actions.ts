/**
 * schedule/auto/actions.ts — Server actions for the auto-scheduler (Slice 4b).
 *
 * Two actions:
 *   previewAutoScheduleAction — read-only; no INSERT, no audit, no run header.
 *   runAutoScheduleAction     — commits proposals through gatedCreateOccurrence.
 *
 * BOUNDARY: imports only from @aeroops/api — never @aeroops/db.
 * AUTHZ: enforced server-side by previewAutoSchedule / runAutoSchedule
 *   (requireCapability('schedule:create_reservation')). These actions map errors.
 *
 * DATE SERIALIZATION: Dates are serialized at this boundary so client components
 * receive plain strings/numbers, not Date objects (Next.js server action caveat).
 * The actions accept windowStartUtcMs/windowEndUtcMs/earliestStartUtcMs/
 * latestEndUtcMs as number (epoch ms) — no Date objects cross the boundary.
 */
'use server';

import { actionAuth as auth } from '@/lib/action-auth';
import { previewAutoSchedule, runAutoSchedule } from '@aeroops/api';
import type {
  PreviewAutoScheduleResult,
  AutoScheduleResult,
} from '@aeroops/api';

// ─── Error shapes (mirrors schedule/actions.ts convention) ────────────────────

import { mapAuthError, isValidationError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ValidationErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ValidationErrorResult, ServerErrorResult };

function stripPrefix(msg: string): string {
  return msg.replace(/^\[[\w:]+\]\s*/, '');
}

// ─── Wire types (Date→serialized crossing the server-action boundary) ─────────

/**
 * SerializedPreviewProposal — PreviewAutoProposalReport with Date→string.
 * The client receives these as strings and parses back to Date when rendering.
 */
export interface SerializedPreviewProposal {
  demandId: string;
  startAt: string; // ISO string
  endAt: string;   // ISO string
  resourceIds: string[];
  wouldResult: 'create' | 'skip';
  reason?: 'conflict' | 'policy' | 'conflict_and_policy' | 'twilight' | 'availability';
}

export interface SerializedPreviewResult {
  proposals: SerializedPreviewProposal[];
  unschedulable: Array<{ demandId: string; reason: 'no_feasible_window' | 'over_constrained' }>;
  wouldCreateCount: number;
  wouldSkipCount: number;
}

export type PreviewAutoScheduleActionResult =
  | ({ ok: true } & SerializedPreviewResult)
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

/**
 * SerializedCommitProposal — AutoProposalReport with Date→string.
 */
export interface SerializedCommitProposal {
  demandId: string;
  startAt: string;
  endAt: string;
  resourceIds: string[];
  result: 'created' | 'skipped';
  reservationId?: string;
  reason?: 'conflict' | 'policy' | 'conflict_and_policy' | 'twilight' | 'availability';
}

export interface SerializedCommitResult {
  runId: string;
  proposals: SerializedCommitProposal[];
  unschedulable: Array<{ demandId: string; reason: 'no_feasible_window' | 'over_constrained' }>;
  createdCount: number;
  skippedCount: number;
}

export type RunAutoScheduleActionResult =
  | ({ ok: true } & SerializedCommitResult)
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

// ─── previewAutoScheduleAction ────────────────────────────────────────────────

/**
 * previewAutoScheduleAction — advisory read-only preview of what runAutoSchedule
 * would produce. Writes nothing; no INSERT, no audit, no run header.
 *
 * input.demands[].earliestStartUtcMs / latestEndUtcMs are epoch ms numbers.
 * Dates in the response are serialized to ISO strings.
 */
export async function previewAutoScheduleAction(input: {
  demands: Array<{
    id: string;
    requiredResourceIds: string[];
    durationMinutes: number;
    earliestStartUtcMs?: number;
    latestEndUtcMs?: number;
    priority?: number;
  }>;
  windowStartUtcMs: number;
  windowEndUtcMs: number;
  objective?: 'maximize_utilization' | 'maximize_sessions_scheduled';
}): Promise<PreviewAutoScheduleActionResult> {
  const session = await auth();
  try {
    const result: PreviewAutoScheduleResult = await previewAutoSchedule(session, input);
    // Serialize Dates → ISO strings at the server action boundary.
    return {
      ok: true,
      proposals: result.proposals.map((p) => ({
        demandId: p.demandId,
        startAt: p.startAt instanceof Date ? p.startAt.toISOString() : String(p.startAt),
        endAt: p.endAt instanceof Date ? p.endAt.toISOString() : String(p.endAt),
        resourceIds: p.resourceIds,
        wouldResult: p.wouldResult,
        ...(p.reason ? { reason: p.reason } : {}),
      })),
      unschedulable: result.unschedulable,
      wouldCreateCount: result.wouldCreateCount,
      wouldSkipCount: result.wouldSkipCount,
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── runAutoScheduleAction ────────────────────────────────────────────────────

/**
 * runAutoScheduleAction — commit a demand set through gatedCreateOccurrence.
 * DESTRUCTIVE (creates reservations). Requires explicit user confirmation in the
 * UI — the "Commit schedule" button is a deliberate secondary action; auto-commit
 * is forbidden by spec §4b.3.
 *
 * Always ok:true (partial-create is normal). Auth/validation errors throw and are
 * mapped to error result shapes.
 *
 * Dates in the response are serialized to ISO strings.
 */
export async function runAutoScheduleAction(input: {
  demands: Array<{
    id: string;
    requiredResourceIds: string[];
    durationMinutes: number;
    earliestStartUtcMs?: number;
    latestEndUtcMs?: number;
    priority?: number;
  }>;
  windowStartUtcMs: number;
  windowEndUtcMs: number;
  objective?: 'maximize_utilization' | 'maximize_sessions_scheduled';
}): Promise<RunAutoScheduleActionResult> {
  const session = await auth();
  try {
    const result: AutoScheduleResult = await runAutoSchedule(session, input);
    // Serialize Dates → ISO strings at the server action boundary.
    return {
      ok: true,
      runId: result.runId,
      proposals: result.proposals.map((p) => ({
        demandId: p.demandId,
        startAt: p.startAt instanceof Date ? p.startAt.toISOString() : String(p.startAt),
        endAt: p.endAt instanceof Date ? p.endAt.toISOString() : String(p.endAt),
        resourceIds: p.resourceIds,
        result: p.result,
        ...(p.reservationId ? { reservationId: p.reservationId } : {}),
        ...(p.reason ? { reason: p.reason } : {}),
      })),
      unschedulable: result.unschedulable,
      createdCount: result.createdCount,
      skippedCount: result.skippedCount,
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}
