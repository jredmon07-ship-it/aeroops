/**
 * dispatch-gate/eligibility-gate.ts — pure eligibility gate decision function.
 *
 * The `@aeroops/core` half of ADR-0009 §2 (Slice 3c). No I/O, no Drizzle, no
 * React, no clock (`Date.now()`), no randomness. This computes which required
 * tags are missing from a pilot's tag set and whether the pilot is blocked or
 * warned.
 *
 * PURE & DETERMINISTIC: same inputs always produce deep-equal outputs. Safe to
 * call in isolation and property-test for all invariants.
 *
 * SCOPE (Slice 3c):
 *   - Only string membership set-difference. Tags are OPAQUE free-text labels
 *     defined by the operator. This function applies no interpretation to tag
 *     content — it does NOT know or care whether a tag represents a certificate,
 *     endorsement, training milestone, or anything else.
 *   - 'mode' mirrors the grounding gate seam. 'block' → blocked on any missing
 *     tag; 'warn' → advisory only. The caller passes the org's configured mode
 *     (default 'block' per spec).
 *
 * COMPLIANCE:
 *   [VERIFY-3c-A] This function computes NO FAA currency, medical, flight-review,
 *   endorsement, Part 61/141, or other regulatory determination. It is a pure
 *   string set-membership test over operator-defined opaque labels. Eligibility
 *   blocking via this gate means the OPERATOR has enforced their own tag rule —
 *   it is NOT a software determination that the pilot is legally unqualified.
 *   Do NOT import any date/clock/currency logic into this file.
 */

/**
 * EligibilityGateResult — output of evaluateEligibilityGate.
 *
 * Exact semantics:
 *   - `satisfied`    — true iff `missingTags` is empty (pilot holds all required tags).
 *   - `missingTags`  — case-sensitive set difference (requiredTags \ pilotTags),
 *                      de-duplicated and order-preserved from `requiredTags`.
 *   - `blocked`      — true iff mode='block' AND !satisfied; false in all other cases.
 *   - `warnings`     — mode='warn' AND !satisfied → contains missingTags; otherwise [].
 *
 * Invariants guaranteed by the pure function:
 *   E3: satisfied ⟺ missingTags.length === 0
 *   E4: mode='block' ⇒ blocked = !satisfied, warnings = []
 *       mode='warn'  ⇒ blocked = false,       warnings = missingTags
 *       The two arms are mutually exclusive: blocked && warnings.length>0 is impossible.
 */
export interface EligibilityGateResult {
  satisfied: boolean;
  missingTags: string[];
  blocked: boolean;
  warnings: string[];
}

/**
 * evaluateEligibilityGate — pure eligibility gate over pilot tag membership.
 *
 * Computes which of `requiredTags` are absent from `pilotTags` (case-sensitive
 * exact string comparison), then partitions the result into `blocked` / `warnings`
 * depending on `mode`.
 *
 * @param requiredTags - The operator-defined required tags for this aircraft.
 *   May be empty (no gate applies). Duplicates in this list are de-duplicated in
 *   `missingTags` output but the order of the FIRST occurrence is preserved.
 * @param pilotTags    - The tags currently held by the pilot. Used only for
 *   membership testing — content is never interpreted.
 * @param mode         - 'block' → blocked=!satisfied, warnings=[];
 *                       'warn'  → blocked=false, warnings=missingTags.
 * @returns EligibilityGateResult with the exact semantics described above.
 *
 * [VERIFY-3c-A] No FAA/regulatory logic — pure string membership only.
 */
export function evaluateEligibilityGate(
  requiredTags: string[],
  pilotTags: string[],
  mode: 'block' | 'warn',
): EligibilityGateResult {
  // E1: Empty requiredTags → no gate — always satisfied, no blocks, no warnings.
  if (requiredTags.length === 0) {
    return { satisfied: true, missingTags: [], blocked: false, warnings: [] };
  }

  const pilotTagSet = new Set<string>(pilotTags);

  // Build missingTags: set-difference (requiredTags \ pilotTags), deduped,
  // order preserved from requiredTags (first occurrence wins).
  const seen = new Set<string>();
  const missingTags: string[] = [];
  for (const tag of requiredTags) {
    if (!pilotTagSet.has(tag) && !seen.has(tag)) {
      missingTags.push(tag);
      seen.add(tag);
    }
  }

  // E3: satisfied ⟺ missingTags is empty.
  const satisfied = missingTags.length === 0;

  // E4: mode partition — mutually exclusive arms.
  if (mode === 'block') {
    return {
      satisfied,
      missingTags,
      blocked: !satisfied,
      warnings: [],
    };
  } else {
    // mode === 'warn'
    return {
      satisfied,
      missingTags,
      blocked: false,
      warnings: missingTags,
    };
  }
}
