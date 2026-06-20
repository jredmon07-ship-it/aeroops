/**
 * maintenance/work-order-rules.ts — pure work-order domain rules.
 *
 * No I/O, no Drizzle, no React. Safe to property-test and share across
 * web and mobile.
 *
 * Compliance: every rule here operates on operator data. No FAR/Part-43/
 * airworthiness determination is made. Ungrounding is an explicit operator
 * action; this rule is a convenience guard, NOT a computed clearance.
 * [VERIFY-M1-D]
 */

// ─── shouldUngroundForWorkOrder ───────────────────────────────────────────────

/**
 * GroundingBasisEntry — the minimum grounding-probe shape this rule needs.
 *
 * The caller (completeWorkOrder) already holds a GroundingProbeEntry (from
 * loadGroundingProbe) extended with squawkId. We require only the fields we
 * need, so the rule stays decoupled from any DB type.
 */
export interface GroundingBasisEntry {
  /** true if the aircraft is currently in the 'grounded' state. */
  grounded: boolean;
  /**
   * squawkId that caused the latest grounding event, or null if the aircraft
   * is not grounded, the grounding was created without a squawk link, or the
   * linked squawk was later hard-deleted (SET NULL FK).
   */
  squawkId: string | null;
}

/**
 * ShouldUngroundResult — discriminated output of shouldUngroundForWorkOrder.
 *
 *   ok:true                           → proceed to unground.
 *   ok:false 'not_grounded'           → the aircraft is not currently grounded;
 *                                        no unground needed (no-op, idempotent).
 *   ok:false 'grounded_for_other_reason' → the aircraft IS grounded, but the latest
 *                                        grounding event is NOT linked to this WO's
 *                                        squawk; do NOT unground (conservative guard).
 *   ok:false 'no_matching_grounding_basis' → the WO has a squawkId but the current
 *                                        grounding event has a NULL squawkId, or the
 *                                        WO has no squawkId at all (grounding-basis
 *                                        mismatch; operator must unground manually).
 *
 * COMPLIANCE [VERIFY-M1-D]: the 'ok:false' arms do NOT ground the aircraft;
 * they simply decline to automatically unground it. The operator retains full
 * manual control via unGroundAircraft.
 */
export type ShouldUngroundResult =
  | { ok: true }
  | { ok: false; reason: 'not_grounded' | 'grounded_for_other_reason' | 'no_matching_grounding_basis' };

/**
 * shouldUngroundForWorkOrder — pure predicate for the completeWorkOrder
 * auto-unground decision.
 *
 * Unground is allowed ONLY when:
 *   1. The aircraft is currently grounded.
 *   2. The latest grounding event's squawkId is non-null AND equals the WO's
 *      squawkId (which must also be non-null).
 *
 * Conservative: a null squawkId on either side (no link on the grounding event,
 * or WO has no linked squawk) yields 'no_matching_grounding_basis' — the
 * operator must unground manually.
 *
 * A grounding linked to a DIFFERENT squawk yields 'grounded_for_other_reason' —
 * the aircraft must remain grounded (unrelated maintenance issue still open).
 *
 * NOT grounded at all → 'not_grounded' (idempotent no-op).
 *
 * @param groundingEntry  — current probe for the aircraft (from loadGroundingProbe).
 * @param workOrderSquawkId — the squawk_id column from the work order row (may be null).
 */
export function shouldUngroundForWorkOrder(
  groundingEntry: GroundingBasisEntry,
  workOrderSquawkId: string | null,
): ShouldUngroundResult {
  // Rule 1: must actually be grounded.
  if (!groundingEntry.grounded) {
    return { ok: false, reason: 'not_grounded' };
  }

  // Rule 2: both the WO and the latest grounding event must have a squawkId, and
  // they must match.
  const groundingSquawkId = groundingEntry.squawkId;

  if (workOrderSquawkId === null || groundingSquawkId === null) {
    // One or both sides lack a squawk link — cannot confirm same-basis match.
    return { ok: false, reason: 'no_matching_grounding_basis' };
  }

  if (groundingSquawkId !== workOrderSquawkId) {
    // Aircraft is grounded, but for a different squawk.
    return { ok: false, reason: 'grounded_for_other_reason' };
  }

  // Both sides have the same squawkId — safe to unground.
  return { ok: true };
}
