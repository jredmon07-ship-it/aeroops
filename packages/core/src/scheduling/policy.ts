/**
 * scheduling/policy.ts — pure booking-policy evaluation predicate.
 *
 * The `@aeroops/core` half of ADR-0005. No I/O, no Drizzle, no React, no clock.
 * This is ADVISORY only: it powers the pre-submit policy preview and the rich
 * refusal naming each violated rule. It is NEVER the sole gate on a write — the
 * authoritative enforcement is the single sanctioned create path running this
 * predicate inside `withSessionOrgContext` (ADR-0005 invariant 1). There is no
 * DB backstop for these rules (unlike the conflict EXCLUDE).
 *
 * PURITY: `now` is INJECTED (epoch ms). We never call `Date.now()` here — that
 * keeps the predicate pure, deterministic, and property-testable (ADR-0005
 * invariant 2). The caller captures `now` once per evaluation.
 *
 * HALF-OPEN SEMANTICS: every interval is `[start, end)` (start inclusive, end
 * exclusive) in epoch milliseconds — same discipline as overlap.ts and the DB's
 * `tstzrange(start, end, '[)')`. Blackout adjacency is NOT a violation. We REUSE
 * `intervalsOverlap` for blackout membership; we never reimplement overlap
 * (ADR-0005 invariants 3, 4; overlap.ts is FROZEN).
 *
 * SCOPE AMENDMENT (2026-06-16, maintainer): Slice 2a evaluates FOUR rules only —
 * max duration, max advance, min lead time, blackouts. Required-tags / booking
 * eligibility (and the `actorTags` parameter) is DEFERRED to a follow-up slice.
 */

import { intervalsOverlap } from './overlap.js';
import type { PolicyViolationKind } from './enums.js';

/** Epoch-ms milliseconds in one minute / one fixed 24h day. */
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * BookingPolicy — the resolved, operator-defined rule set for one resource.
 *
 * Each limit is independently optional: `null` means "this rule is unset" and
 * is skipped entirely (never a violation). All four-rule semantics use strict
 * inequalities, so a value exactly at the limit is OK.
 *
 * SCOPE AMENDMENT: `requiredTags` is intentionally absent in Slice 2a.
 */
export interface BookingPolicy {
  /** Max booking length in minutes; `null` = no max-duration rule. */
  readonly maxDurationMinutes: number | null;
  /** Max lead time in fixed 24h days; `null` = no max-advance rule. */
  readonly maxAdvanceDays: number | null;
  /** Min lead time in minutes; `null` = no min-lead rule. */
  readonly minAdvanceMinutes: number | null;
}

/**
 * BlackoutWindow — a single per-resource unavailable window, half-open
 * `[start, end)` in epoch ms. The caller supplies these org-scoped and already
 * narrowed to the candidate's resource; this predicate is org-agnostic by
 * design (resourceIds are globally unique per ADR-0004).
 */
export interface BlackoutWindow {
  /** epoch ms, start (inclusive). */
  readonly start: number;
  /** epoch ms, end (exclusive). */
  readonly end: number;
}

/** A proposed booking under policy evaluation (single resource). */
export interface PolicyCandidate {
  /** The resourceId this booking would hold. */
  readonly resourceId: string;
  /** epoch ms, start (inclusive). */
  readonly start: number;
  /** epoch ms, end (exclusive). */
  readonly end: number;
}

/** The proposed booking is longer than the resource's max-duration rule. */
export interface MaxDurationExceededViolation {
  readonly kind: 'max_duration_exceeded';
  readonly resourceId: string;
  /** The policy limit, in minutes. */
  readonly limitMinutes: number;
  /** The candidate's actual duration, in minutes (`(end-start)/60000`). */
  readonly actualMinutes: number;
}

/** The proposed start is further ahead of `now` than the max-advance rule. */
export interface TooFarInAdvanceViolation {
  readonly kind: 'too_far_in_advance';
  readonly resourceId: string;
  /** The policy limit, in fixed 24h days. */
  readonly limitDays: number;
  /** The candidate's actual lead time, in fixed 24h days (`(start-now)/86_400_000`). */
  readonly actualDays: number;
}

/** The proposed start is closer to `now` than the min-lead rule (or in the past). */
export interface InsufficientLeadTimeViolation {
  readonly kind: 'insufficient_lead_time';
  readonly resourceId: string;
  /** The policy requirement, in minutes. */
  readonly requiredMinutes: number;
  /** The candidate's actual lead time, in minutes (`(start-now)/60000`; negative ⇒ past). */
  readonly actualMinutes: number;
}

/** The proposed window overlaps a resource blackout (half-open). */
export interface BlackoutOverlapViolation {
  readonly kind: 'blackout_overlap';
  readonly resourceId: string;
  /** epoch ms, start of the overlapping blackout (inclusive). */
  readonly blackoutStart: number;
  /** epoch ms, end of the overlapping blackout (exclusive). */
  readonly blackoutEnd: number;
}

/**
 * PolicyViolation — discriminated union over `kind`, one arm per rule.
 *
 * Each arm carries the resourceId, the policy limit, and the candidate's actual
 * value so the API/UI layers can render exact copy without re-deriving anything.
 */
export type PolicyViolation =
  | MaxDurationExceededViolation
  | TooFarInAdvanceViolation
  | InsufficientLeadTimeViolation
  | BlackoutOverlapViolation;

// Compile-time assurance the union's discriminants stay in lock-step with the
// enum tuple (and that no fifth/tag arm sneaks in during 2a).
type _AssertKindsMatch = PolicyViolation['kind'] extends PolicyViolationKind ? true : never;
const _kindsMatch: _AssertKindsMatch = true;
void _kindsMatch;

/**
 * evaluateBookingPolicy — collect EVERY booking-policy violation for a
 * candidate (no short-circuit).
 *
 * Returns the violations in deterministic RULE order:
 *   1. max_duration_exceeded
 *   2. too_far_in_advance
 *   3. insufficient_lead_time
 *   4. blackout_overlap (one per overlapping blackout, in input order)
 * An empty array means the candidate clears every rule.
 *
 * Semantics (all strict inequalities ⇒ a value exactly at the limit is OK):
 *   - `policy === null` ⇒ the three policy rules are SKIPPED, but blackouts are
 *     still evaluated when supplied. A blackout is a resource-availability fact
 *     independent of a policy row (ADR-0005 §4 / [DEFER-D]).
 *   - max_duration_exceeded: when `maxDurationMinutes != null`, violation iff
 *     `(end - start) / 60000 > limit`.
 *   - too_far_in_advance: when `maxAdvanceDays != null`, violation iff
 *     `start - now > days * 86_400_000`.
 *   - insufficient_lead_time: when `minAdvanceMinutes != null`, violation iff
 *     `start - now < minutes * 60_000` (a past start is therefore a violation).
 *   - blackout_overlap: per blackout, violation iff `intervalsOverlap` of the
 *     candidate window and the blackout window (adjacency is NOT a violation).
 *
 * Pure: no I/O, no mutation of inputs, no internal clock.
 *
 * @param candidate - the proposed booking (resourceId + half-open window)
 * @param policy    - the resolved per-resource policy, or `null` for open booking
 * @param blackouts - resource blackout windows to check against (input order kept)
 * @param now       - INJECTED current time, epoch ms (never `Date.now()` here)
 * @returns all violations in rule order; `[]` if the candidate clears every rule
 */
export function evaluateBookingPolicy(
  candidate: PolicyCandidate,
  policy: BookingPolicy | null,
  blackouts: ReadonlyArray<BlackoutWindow>,
  now: number,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const { resourceId, start, end } = candidate;

  if (policy !== null) {
    // 1. max_duration_exceeded — pure function of the candidate's own window.
    if (policy.maxDurationMinutes !== null) {
      const actualMinutes = (end - start) / MS_PER_MINUTE;
      if (actualMinutes > policy.maxDurationMinutes) {
        violations.push({
          kind: 'max_duration_exceeded',
          resourceId,
          limitMinutes: policy.maxDurationMinutes,
          actualMinutes,
        });
      }
    }

    // 2. too_far_in_advance — lead time vs the fixed-24h-day max.
    if (policy.maxAdvanceDays !== null) {
      const lead = start - now;
      if (lead > policy.maxAdvanceDays * MS_PER_DAY) {
        violations.push({
          kind: 'too_far_in_advance',
          resourceId,
          limitDays: policy.maxAdvanceDays,
          actualDays: lead / MS_PER_DAY,
        });
      }
    }

    // 3. insufficient_lead_time — lead time vs the min-lead floor (past ⇒ viol).
    if (policy.minAdvanceMinutes !== null) {
      const lead = start - now;
      if (lead < policy.minAdvanceMinutes * MS_PER_MINUTE) {
        violations.push({
          kind: 'insufficient_lead_time',
          resourceId,
          requiredMinutes: policy.minAdvanceMinutes,
          actualMinutes: lead / MS_PER_MINUTE,
        });
      }
    }
  }

  // 4. blackout_overlap — always evaluated (independent of the policy row).
  //    One violation per overlapping blackout, in input order. REUSES the frozen
  //    intervalsOverlap; adjacency is NOT a violation (half-open).
  for (const b of blackouts) {
    if (intervalsOverlap(start, end, b.start, b.end)) {
      violations.push({
        kind: 'blackout_overlap',
        resourceId,
        blackoutStart: b.start,
        blackoutEnd: b.end,
      });
    }
  }

  return violations;
}
