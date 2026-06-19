/**
 * maintenance/enums.ts — single source of truth for maintenance enum types.
 *
 * Mirrors the scheduling/enums.ts pattern: both @aeroops/db (pgEnum) and the
 * application layer import these tuples so the Drizzle schema and the runtime
 * can never drift. The schema-engineer builds pgEnums FROM these `as const`
 * tuples.
 *
 * No I/O, framework-agnostic — safe to import anywhere.
 *
 * COMPLIANCE:
 *   - GroundingState: operator-set status only; no FAR/Part-91/43 determination.
 *   - SquawkStatus: 'deferred' is a plain operator status with a reason, NOT an
 *     MEL/airworthiness construct. [VERIFY-3b-A]
 *   - SquawkSeverity: 'grounding' is a UI triage label only — it does NOT
 *     auto-ground the aircraft. [VERIFY-3b-B]
 */

// ─── Grounding state ──────────────────────────────────────────────────────────

/**
 * GROUNDING_STATES — canonical list of aircraft grounding event states.
 *
 * Order matters: Postgres enum types preserve insertion order and some tooling
 * displays them in this order. Do NOT reorder without a migration.
 *
 * Current state per aircraft = the state of its latest event row
 * (append-only event table). 'grounded' means the operator has set the
 * aircraft as not available for dispatch. 'released' means the operator has
 * cleared the grounding. This is operator data, never a computed reg verdict.
 */
export const GROUNDING_STATES = ['grounded', 'released'] as const;

/** Union type of all valid grounding state strings. */
export type GroundingState = (typeof GROUNDING_STATES)[number];

/**
 * isGroundingState — runtime type guard for GroundingState.
 *
 * Returns true only when `value` is a string that is an exact member of
 * GROUNDING_STATES. Returns false for non-strings, unknown/future state
 * strings, and prototype-chain keys ('constructor', 'toString', etc.).
 * Use at untrusted boundaries.
 *
 * @param value - Any unknown value from an untrusted source.
 * @returns `true` if value is a valid GroundingState, `false` otherwise.
 */
export function isGroundingState(value: unknown): value is GroundingState {
  return typeof value === 'string' && (GROUNDING_STATES as readonly string[]).includes(value);
}

// ─── Squawk status ────────────────────────────────────────────────────────────

/**
 * SQUAWK_STATUSES — canonical list of squawk lifecycle statuses.
 *
 * Order matters (see GROUNDING_STATES). Transitions: open → resolved or
 * open → deferred only. No reopen path ([VERIFY-3b-D]).
 *
 * 'open'     = reported; not yet addressed.
 * 'deferred' = acknowledged by operator; noted for later; NOT an MEL/airworthiness
 *              construct — purely an operator triage status with a reason string.
 * 'resolved' = addressed and signed off by a mechanic or manager.
 */
export const SQUAWK_STATUSES = ['open', 'deferred', 'resolved'] as const;

/** Union type of all valid squawk status strings. */
export type SquawkStatus = (typeof SQUAWK_STATUSES)[number];

/**
 * isSquawkStatus — runtime type guard for SquawkStatus.
 *
 * Same contract as isGroundingState, over SQUAWK_STATUSES.
 *
 * @param value - Any unknown value from an untrusted source.
 * @returns `true` if value is a valid SquawkStatus, `false` otherwise.
 */
export function isSquawkStatus(value: unknown): value is SquawkStatus {
  return typeof value === 'string' && (SQUAWK_STATUSES as readonly string[]).includes(value);
}

// ─── Squawk severity ──────────────────────────────────────────────────────────

/**
 * SQUAWK_SEVERITIES — canonical list of squawk severity labels.
 *
 * Order matters (see GROUNDING_STATES). This is an operator triage label,
 * not a computed airworthiness class. 'grounding' is a UI hint only —
 * it does NOT auto-ground the aircraft. A squawk with severity='grounding'
 * must be paired with an explicit groundAircraft call to produce a grounding
 * event. [VERIFY-3b-B]
 */
export const SQUAWK_SEVERITIES = ['low', 'medium', 'high', 'grounding'] as const;

/** Union type of all valid squawk severity strings. */
export type SquawkSeverity = (typeof SQUAWK_SEVERITIES)[number];

/**
 * isSquawkSeverity — runtime type guard for SquawkSeverity.
 *
 * Same contract as isGroundingState, over SQUAWK_SEVERITIES.
 *
 * @param value - Any unknown value from an untrusted source.
 * @returns `true` if value is a valid SquawkSeverity, `false` otherwise.
 */
export function isSquawkSeverity(value: unknown): value is SquawkSeverity {
  return typeof value === 'string' && (SQUAWK_SEVERITIES as readonly string[]).includes(value);
}
