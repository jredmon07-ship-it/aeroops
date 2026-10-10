/**
 * capabilities.ts — Role-capability matrix for AeroOps RBAC.
 *
 * This is the single source of truth for what each role can do.
 * It is framework-agnostic and has no I/O — it is safe to import
 * anywhere (web, mobile, api).
 *
 * AUTHZ INVARIANT:
 *   All permission checks MUST go through `can()` or `requireCapability()`
 *   (in @aeroops/api). Raw `role === 'x'` guards are forbidden.
 *
 * EXTENSIBILITY:
 *   New capabilities are added here (e.g. 'schedule:create' in Slice 1).
 *   ROLE_CAPABILITIES must remain exhaustive over MEMBERSHIP_ROLES — the
 *   `satisfies` constraint enforces this at compile time.
 *
 * FAIL-CLOSED CONTRACT:
 *   can() returns false for any unknown role or unknown capability.
 *   It never throws.
 */
import { MEMBERSHIP_ROLES } from './roles.js';
import type { MembershipRole } from './roles.js';

// ─── Capability registry ──────────────────────────────────────────────────────

/**
 * CAPABILITIES — exhaustive list of all defined capabilities.
 *
 * Keep this sorted alphabetically so diffs are minimal when new capabilities
 * are added in later Hub slices.
 *
 * DO NOT add Hub-specific capabilities here until the corresponding Hub
 * slice is approved (schedule:*, etc.).
 */
export const CAPABILITIES = [
  'app:access',
  'booking:triage',
  'dispatch:access',
  'dispatch:create',
  'dispatch:manage_requirements',
  'fleet:access',
  'fleet:manage',
  'maintenance:access',
  'maintenance:ground',
  'maintenance:squawk',
  'maintenance:work_order',
  'org:manage_settings',
  'people:access',
  'people:manage',
  'portal:access',
  'reporting:access',
  'schedule:access',
  'schedule:create_reservation',
  'schedule:manage_resources',
  'training:access',
  'training:manage',
] as const;

/** Union type of all valid capability strings. */
export type Capability = (typeof CAPABILITIES)[number];

// ─── Role → capability matrix ─────────────────────────────────────────────────

/**
 * ROLE_CAPABILITIES — maps every MembershipRole to the capabilities it grants.
 *
 * The `satisfies Record<MembershipRole, readonly Capability[]>` constraint
 * makes it a compile error to:
 *   (a) add a new role to MEMBERSHIP_ROLES without updating this matrix, or
 *   (b) list a string that is not a valid Capability.
 *
 * Matrix (rows = roles, columns = capabilities):
 *
 *   Role          | app:access | booking:triage | dispatch:access | dispatch:create | dispatch:manage_requirements | fleet:access | fleet:manage | maintenance:access | maintenance:ground | maintenance:squawk | maintenance:work_order | org:manage_settings | people:access | people:manage | portal:access | reporting:access | schedule:access | schedule:create_reservation | schedule:manage_resources | training:access | training:manage |
 *   --------------|------------|----------------|-----------------|-----------------|------------------------------|--------------|--------------|--------------------|--------------------|--------------------|-----------------------|--------------------|---------------|---------------|---------------|------------------|--------------------|-----------------------------|---------------------------|-----------------|-----------------|
 *   owner         |     ✓      |       ✓        |        ✓        |        ✓        |              ✓               |      ✓       |      ✓       |         ✓          |         ✓          |         ✓          |           ✓           |          ✓          |       ✓       |       ✓       |       ✓       |        ✓         |        ✓        |              ✓              |             ✓             |        ✓        |        ✓        |
 *   manager       |     ✓      |       ✓        |        ✓        |        ✓        |              ✓               |      ✓       |      ✓       |         ✓          |         ✓          |         ✓          |           ✓           |          ✓          |       ✓       |       ✓       |       ✓       |        ✓         |        ✓        |              ✓              |             ✓             |        ✓        |        ✓        |
 *   dispatcher    |     ✓      |       ✓        |        ✓        |        ✓        |              ✓               |      ✓       |      ✓       |         ✓          |         ✓          |         ✓          |           ✓           |                     |       ✓       |               |               |        ✓         |        ✓        |              ✓              |             ✓             |        ✓        |                 |
 *   cfi           |     ✓      |                |        ✓        |        ✓        |                              |      ✓       |              |         ✓          |                    |         ✓          |                       |                     |       ✓       |               |               |        ✓         |        ✓        |              ✓              |                           |        ✓        |        ✓        |
 *   mechanic      |     ✓      |                |                 |                 |                              |      ✓       |      ✓       |         ✓          |         ✓          |         ✓          |           ✓           |                     |               |               |               |                  |                 |                             |                           |                 |                 |
 *   renter        |     ✓      |                |                 |                 |                              |              |              |                    |                    |                    |                       |                     |               |               |       ✓       |                  |                 |                             |                           |                 |                 |
 *   student       |     ✓      |                |                 |                 |                              |              |              |                    |                    |                    |                       |                     |               |               |       ✓       |                  |                 |                             |                           |                 |                 |
 *   accountant    |     ✓      |                |                 |                 |                              |              |              |                    |                    |                    |                       |                     |               |               |               |        ✓         |                 |                             |                           |                 |                 |
 *
 * NOTE: booking:triage → owner/manager/dispatcher (NOT cfi/mechanic/renter/student/
 *       accountant; Slice PB1.2). Staff inbox: list + triage booking requests.
 *       No money; converted sets status only — does NOT create a reservation in PB1.
 * NOTE: schedule:create_reservation also gates reservation cancel in Slice 1.
 * NOTE: dispatch:access + dispatch:create granted to owner/manager/dispatcher/cfi
 *       (parity with schedule:access; ADR-0007 §6 / Slice 3a).
 * NOTE: dispatch:manage_requirements → owner/manager/dispatcher (NOT cfi/mechanic/
 *       renter/student/accountant; conductor decision 2026-06-19, Slice 3c ADR-0009).
 * NOTE: maintenance:access → owner/manager/dispatcher/cfi/mechanic (Slice 3b).
 *       maintenance:ground → owner/manager/dispatcher/mechanic (NOT cfi, Slice 3b).
 *       maintenance:squawk → owner/manager/dispatcher/cfi/mechanic (NOT renter/student, Slice 3b).
 *       maintenance:work_order → owner/manager/dispatcher/mechanic (NOT cfi/accountant/
 *         renter/student; LOCKED decision #1 Slice M1.2).
 * NOTE: fleet:access → owner/manager/dispatcher/cfi/mechanic (Slice 5).
 *       fleet:manage → owner/manager/dispatcher/mechanic (NOT cfi — CFI reads, can't edit
 *       identity; decision (b) 2026-06-18).
 *       renter/student/accountant get neither fleet cap.
 * NOTE: people:access → owner/manager/dispatcher/cfi (read roster). Slice 6.
 *       people:manage → owner/manager ONLY (NOT dispatcher/cfi — they read but can't
 *       change roles/status/tags; decision 2026-06-19).
 *       mechanic/renter/student/accountant get neither people cap.
 * NOTE: reporting:access → owner/manager/dispatcher/cfi/accountant (Slice 7 D3).
 *       mechanic/renter/student do NOT get reporting:access.
 *       accountant included — a read-only reporting viewer (Dashboard/Reports/Activity).
 * NOTE: training:access → owner/manager/dispatcher/cfi (read courses/enrollments).
 *       training:manage → owner/manager/cfi (build courses, enroll, record, void).
 *       dispatcher has access (read) but NOT manage in T1.
 *       student/renter/mechanic/accountant get NEITHER training cap in T1 (Slice T1.2).
 *       Student self-service portal delivered in P1 via the standalone portal:access
 *       cap (resolves [VERIFY-T1-H]); broad training:access stays NOT granted to
 *       student/renter — they see ONLY their own progress through the portal reads.
 * NOTE: portal:access → owner/manager/student/renter (Slice P1.1). The student/renter
 *       self-service portal cap. STANDALONE — it does NOT transitively grant
 *       training/people/fleet/schedule access. The portal reads (packages/api/src/portal/)
 *       are SEPARATE functions gated SOLELY on portal:access and self-scoped to
 *       session.userId (a member NEVER sees another member's data). owner/manager hold it
 *       so staff can preview the portal; cfi/dispatcher/accountant/mechanic do NOT.
 *       Resolves [VERIFY-T1-H]: own-progress = operator content already recorded about
 *       the member, NOT a new computed Part-61/141 determination.
 */
export const ROLE_CAPABILITIES = {
  owner:      ['app:access', 'booking:triage', 'dispatch:access', 'dispatch:create', 'dispatch:manage_requirements', 'fleet:access', 'fleet:manage', 'maintenance:access', 'maintenance:ground', 'maintenance:squawk', 'maintenance:work_order', 'org:manage_settings', 'people:access', 'people:manage', 'portal:access', 'reporting:access', 'schedule:access', 'schedule:create_reservation', 'schedule:manage_resources', 'training:access', 'training:manage'] as const,
  manager:    ['app:access', 'booking:triage', 'dispatch:access', 'dispatch:create', 'dispatch:manage_requirements', 'fleet:access', 'fleet:manage', 'maintenance:access', 'maintenance:ground', 'maintenance:squawk', 'maintenance:work_order', 'org:manage_settings', 'people:access', 'people:manage', 'portal:access', 'reporting:access', 'schedule:access', 'schedule:create_reservation', 'schedule:manage_resources', 'training:access', 'training:manage'] as const,
  dispatcher: ['app:access', 'booking:triage', 'dispatch:access', 'dispatch:create', 'dispatch:manage_requirements', 'fleet:access', 'fleet:manage', 'maintenance:access', 'maintenance:ground', 'maintenance:squawk', 'maintenance:work_order', 'people:access', 'reporting:access', 'schedule:access', 'schedule:create_reservation', 'schedule:manage_resources', 'training:access'] as const,
  cfi:        ['app:access', 'dispatch:access', 'dispatch:create', 'fleet:access', 'maintenance:access', 'maintenance:squawk', 'people:access', 'reporting:access', 'schedule:access', 'schedule:create_reservation', 'training:access', 'training:manage'] as const,
  mechanic:   ['app:access', 'fleet:access', 'fleet:manage', 'maintenance:access', 'maintenance:ground', 'maintenance:squawk', 'maintenance:work_order'] as const,
  renter:     ['app:access', 'portal:access'] as const,
  student:    ['app:access', 'portal:access'] as const,
  accountant: ['app:access', 'reporting:access'] as const,
} satisfies Record<MembershipRole, readonly Capability[]>;

// Compile-time check: every role in MEMBERSHIP_ROLES must appear as a key.
// TypeScript's `satisfies` above handles this — this comment is the rationale.
// Runtime exhaustiveness: the object keys at runtime should equal MEMBERSHIP_ROLES.
// Verified by unit tests.

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * can — pure predicate: does `role` have `capability`?
 *
 * FAIL-CLOSED: unknown role OR unknown capability → false (never throws).
 * This means any typo or future gap defaults to denied.
 *
 * PROTOTYPE-CHAIN SAFETY: role strings that are Object.prototype member names
 * (e.g. 'constructor', 'toString', '__proto__') would resolve up the prototype
 * chain to a truthy non-array, causing `caps.includes` to throw a TypeError.
 * We guard with both an own-property check AND Array.isArray so that any lookup
 * that escapes the own properties of ROLE_CAPABILITIES returns false rather than
 * throwing.
 *
 * @param role       - A MembershipRole (or any string for safety).
 * @param capability - A Capability (or any string for safety).
 * @returns true if the role has the capability, false otherwise.
 */
export function can(
  role: MembershipRole | (string & {}),
  capability: Capability | (string & {}),
): boolean {
  if (!Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, role)) return false;
  const caps = ROLE_CAPABILITIES[role as MembershipRole];
  if (!Array.isArray(caps)) return false;
  return (caps as readonly string[]).includes(capability);
}

/**
 * capabilitiesForRole — returns the capability list for a role.
 *
 * Returns an empty readonly array for unknown roles (fail-closed).
 * Intended for UI nav building (e.g. hiding menu items). NOT a gate.
 *
 * PROTOTYPE-CHAIN SAFETY: same own-property + Array.isArray guard as can().
 * Prototype-key role strings return [] and never throw.
 *
 * @param role - A MembershipRole (or any string for safety).
 * @returns readonly Capability[] (may be empty).
 */
export function capabilitiesForRole(
  role: MembershipRole | (string & {}),
): readonly Capability[] {
  if (!Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, role)) return [];
  const caps = ROLE_CAPABILITIES[role as MembershipRole];
  if (!Array.isArray(caps)) return [];
  return caps;
}

// ─── Compile-time exhaustiveness guard ───────────────────────────────────────
// Ensures that every entry in MEMBERSHIP_ROLES has a key in ROLE_CAPABILITIES.
// If a new role is added to MEMBERSHIP_ROLES without updating ROLE_CAPABILITIES,
// the `satisfies` above will produce a compile error. This comment explains why.
const _exhaustiveCheck: Record<(typeof MEMBERSHIP_ROLES)[number], unknown> =
  ROLE_CAPABILITIES;
void _exhaustiveCheck; // suppress "unused variable" warnings
