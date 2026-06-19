/**
 * maintenance/grounding-gate.ts — pure grounding gate decision function.
 *
 * The `@aeroops/core` half of ADR-0008 §2.3. No I/O, no Drizzle, no React, no
 * clock (`Date.now()`), no randomness. This computes which resources in a
 * candidate set are blocked or warned due to grounding.
 *
 * PURE & DETERMINISTIC: same inputs always produce deep-equal outputs. Safe to
 * call in isolation and property-test for all invariants.
 *
 * SCOPE (Slice 3b):
 *   - Only `kind === 'aircraft'` resources are evaluated. Instructors, sims,
 *     rooms, vehicles are never grounded and must never appear in either result
 *     list — not because they are "cleared" but because the grounding concept
 *     does not apply to them.
 *   - 'mode' provides a seam for a future org-settings slice. In 3b the
 *     create-path caller always passes 'warn'; openDispatch always passes 'block'.
 *     Do NOT build the org-settings infrastructure here — the seam is sufficient.
 *
 * COMPLIANCE:
 *   Grounding is operator data only. This function makes no FAR/Part-91/43/
 *   Part-43 airworthiness determination. [VERIFY-3b-H]
 */

/**
 * GroundingHit — a resource that was evaluated and found to be grounded.
 *
 * `reason` may be null when the operator stored a grounding event with a null/
 * empty reason (the DB CHECK enforces non-empty on 'grounded' state rows, so in
 * practice reason should always be non-null for aircraft in a 'grounded' state;
 * but the gate accepts whatever the caller supplies and passes it through
 * unchanged).
 */
export interface GroundingHit {
  resourceId: string;
  reason: string | null;
}

/**
 * GroundingGateResult — output of evaluateGroundingGate.
 *
 * Exact partition:
 *   - `blocked`  — grounded aircraft when mode='block' (non-empty ⇒ caller should refuse).
 *   - `warnings` — grounded aircraft when mode='warn'  (non-empty ⇒ caller should warn).
 *
 * Invariants guaranteed by the pure function:
 *   G2: mode='block' ⇒ every grounded aircraft in `blocked`, none in `warnings`.
 *       mode='warn'  ⇒ every grounded aircraft in `warnings`, none in `blocked`.
 *   G4: `blocked` ∩ `warnings` = ∅  (no resource in both lists).
 *       |blocked| + |warnings| = count of grounded aircraft in candidateResources.
 */
export interface GroundingGateResult {
  blocked: GroundingHit[];
  warnings: GroundingHit[];
}

/**
 * evaluateGroundingGate — pure gate decision over a set of candidate resources.
 *
 * Filters `candidateResources` by `kind === 'aircraft'` (G3), then partitions
 * the grounded aircraft into either `blocked` or `warnings` depending on `mode`
 * (G2). Released (non-grounded) aircraft appear in neither list (G1).
 *
 * @param candidateResources - The set of resources to evaluate. Each entry
 *   must carry its resourceId, kind, grounded flag, and the current grounding
 *   reason (or null if none). The caller is responsible for loading this data;
 *   this function performs no I/O.
 * @param mode - 'block' routes grounded aircraft into `blocked` (hard stop);
 *   'warn' routes them into `warnings` (advisory). The seam is here for a
 *   future org-settings slice; callers hard-code the value for now.
 * @returns GroundingGateResult with the exact partition described above.
 */
export function evaluateGroundingGate(
  candidateResources: {
    resourceId: string;
    kind: string;
    grounded: boolean;
    reason: string | null;
  }[],
  mode: 'block' | 'warn',
): GroundingGateResult {
  const blocked: GroundingHit[] = [];
  const warnings: GroundingHit[] = [];

  for (const resource of candidateResources) {
    // G3: only aircraft are ever evaluated for grounding.
    if (resource.kind !== 'aircraft') continue;

    // G1: released (non-grounded) aircraft appear in neither list.
    if (!resource.grounded) continue;

    // G2: partition grounded aircraft by mode.
    const hit: GroundingHit = {
      resourceId: resource.resourceId,
      reason: resource.reason,
    };

    if (mode === 'block') {
      blocked.push(hit);
    } else {
      warnings.push(hit);
    }
  }

  return { blocked, warnings };
}
