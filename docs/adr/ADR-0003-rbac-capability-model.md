# ADR-0003 — RBAC: capability-based authorization, server-enforced at the request boundary

**Status:** Accepted (Slice 0.3). **Owners:** CTO, architect. **Builds on:** ADR-0001 (RLS data backstop), ADR-0002 (session = trusted identity).

## Context
Slice 0.3 introduces authorization. The session carries one `MembershipRole`
(from the signed JWT, per ADR-0002), drawn from the 8 roles in THE-BIBLE §2.10.
RLS (ADR-0001) answers *which rows* a session may touch; it does not answer *what
an org-member may DO*. RBAC fills that gap and **layers on** RLS — it never
replaces it. Because every Hub will gate actions on RBAC, the shape chosen here is
inherited everywhere and is expensive to reverse once call sites multiply.

## Decision
- **Capability-based, not role-conditional.** Roles map to **capabilities**; code
  checks capabilities, never role strings. The single-source matrix
  (`ROLE_CAPABILITIES`) and the pure `can(role, capability)` predicate live in
  `@aeroops/core`. Capabilities are typed string literals (`domain:action`), so a
  typo is a compile error. Phase-0 set: `app:access` (all 8 roles — gates the
  shell) and `org:manage_settings` (owner + manager only). Hubs add rows later
  (`schedule:create`, `billing:refund`, …); never role-conditionals at call sites.
- **Server-enforced at the request boundary.** A single choke-point
  `requireCapability(session, capability)` (in `@aeroops/api`) throws
  `UnauthenticatedError` (no/incomplete session) or `ForbiddenError` (role lacks
  the capability) and is called at every gated server entrypoint *before* any data
  fetch. `hasCapability`/`filterNavForSession` use the same `can()` but are
  **UX-only and never the sole gate** — a denied role hitting a gated URL directly
  is redirected server-side, not merely missing a nav link.
- **Fail-closed.** `can()`/`capabilitiesForRole()` return `false`/`[]` for any
  unknown role or capability and **never throw** (own-property/array-safe lookup,
  robust against prototype-chain key strings). `isMembershipRole()` validates the
  role at the session boundary so a malformed/external role degrades to a clean
  deny, not a runtime error.
- **Layered with RLS + identity.** ADR-0002 identity (signed JWT) → ADR-0003 RBAC
  (what you may do) → ADR-0001 RLS (which rows). All three apply on every gated
  tenant action; none substitutes for another.
- **Boundaries acyclic:** matrix + `can()` in `@aeroops/core` (no I/O);
  `requireCapability` in `@aeroops/api`; `apps/web` consumes both, never
  `@aeroops/db`.

## Trust & staleness
`session.role` is authoritative for the JWT's lifetime. A role change (e.g. a
demotion) takes effect on the next token refresh / re-login — a bounded, within-org
window. It can **never** cause a cross-org leak: `role` and `orgId` travel in the
same signed token and RLS scopes every row by `orgId` regardless of role, so a
stale role can at worst over/under-grant within the user's own org. Instant
revocation (session-revocation list / membership-epoch check) is **deferred** to a
later slice, consistent with ADR-0002 deferring instant JWT revocation.

## Invariants (reviewer enforces on every diff)
1. Every gated server entrypoint calls `requireCapability` server-side before touching data.
2. Nav/UI hiding is never the sole gate; the direct-URL-denied test is mandatory.
3. No raw role-string authz (`role === 'owner'`) outside `@aeroops/core`'s matrix.
4. Capability matrix single-sourced in `@aeroops/core`; capabilities are typed literals.
5. RBAC layers on RLS — `requireCapability` never substitutes for `withOrgContext`, or vice versa.
6. `can()`/`capabilitiesForRole()` fail closed and never throw; role validated at the session boundary.

## Risks
Role staleness (accepted, bounded — above); owner-vs-manager boundary set explicitly
per future capability; capability sprawl mitigated by the `domain:action` namespace +
one reviewable matrix file. See [[aeroops-tenant-isolation-invariants]].
