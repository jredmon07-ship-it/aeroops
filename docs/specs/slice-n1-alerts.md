# Slice N1 — In-app notifications / alerts (derived, READ-ONLY) — build spec

**READ-ONLY, derived-on-read, per-user. NO schema/migration, NO write-path hooks, NO frozen-engine mutation, NO money,
NO FAA determination. Sub-slice N1.1 backend derive → N1.2 bell UI.** LOCKED decisions (maintainer-away; architect adopted):
gate = `app:access` then self-scoped to session.userId (NOT portal:access — cfi/dispatcher/etc. get their own alerts);
PERSONAL-ONLY (staff/ops-alerts variant deferred); localStorage per-device "seen" set (no server write); bespoke dropdown
on the EXISTING Radix dialog (NO new dep); two alert kinds; cap MAX_ALERTS=20; stable deterministic ids.

## N1.1 — Backend (`packages/api/src/notifications/`, derived, read-only)
`getMyAlerts(session)` + `getMyAlertsWithDb(db,session)`: `requireCapability(session,'app:access')` FIRST; ONE
`withSessionOrgContextWithDb`; subject = `session.userId` ONLY (no row-id input — zero IDOR); read-only, NOT audited. `now`
injected (defaults new Date) for deterministic tests. Returns `{ alerts: MyAlert[], count }` sorted by `at` ASC, deduped by
id, capped 20. `MyAlert = { id, kind:'reservation_upcoming'|'aircraft_grounded', title, detail, path:string|null (slug-less),
at:Date }`.
**Derivation** (`notifications/internal.ts` `deriveMyAlerts(tx,userId,now)`, NOT exported; ≤2 queries):
1. My upcoming reservations — CLONE the portal `readMyReservations` self-scoped predicate EXACTLY (`status='booked'` AND
   `lower(during)>NOW()` AND (`created_by=me` OR non-voided `dispatch_ticket.pilot_user_id=me`), collapse multi-resource) +
   add the raw `resource_id`s + the tail label + start.
2. `reservation_upcoming`: those starting ≤ now+24h → one alert each (`at`=start; title/detail from tail+start+role;
   id `reservation:{reservationId}:upcoming`; path → schedule day/board for that date).
3. `aircraft_grounded`: collect DISTINCT resource UUIDs across ALL upcoming reservations (not just ≤24h) → `loadGroundingProbe(
   tx, ids)` (from maintenance/internal); for each grounded resource emit one alert per (reservation, grounded-resource):
   id `grounding:{resourceId}:{reservationId}`, `at`=reservation start, title "{tail} is grounded", detail includes the
   operator reason (free text; "No reason given" if blank) + "— contact dispatch" (operator data, NOT an airworthiness ruling).
4. concat → sort `at` ASC → dedupe by id → cap 20 → count=length.
Pure `alertId(kind, parts)` helper (unit-tested determinism). Types in `notifications/types.ts`; barrel-export both forms.

## N1.2 — Web (header bell, apps/web)
`alerts-actions.ts` (`getMyAlertsAction`: await auth → getMyAlerts → serialize Dates). `AlertsBell` client component mounted
ONCE in `(shell)/layout.tsx` (between CommandPalette + user email, slug prop). Bell icon + unread badge (unread = alerts not in
the localStorage seen-set, `9+` clamp, hidden when all seen). Dropdown on the EXISTING `@radix-ui/react-dialog` (focus trap/Esc
free) styled as a top-right panel — NO new dep. States: trigger / loading (skeletons) / empty ("You're all caught up") /
populated (per-row: kind icon [Calendar / AlertTriangle], title bold, detail muted, relative time from `at`, dismiss ×; whole
row links to `/o/{slug}{path}`) / error ("Couldn't load alerts.", quiet, header still renders). Seen-set: localStorage key
`aeroops:alerts-seen:{orgId}:{userId}`, dismiss adds id, "Mark all as seen" clears, prune stale ids on read, try/catch (SSR/
private-mode degrades to live count, never throws). Opening does NOT auto-mark-seen. Fetch on mount + on open (no aggressive
poll). A11y: trigger aria-label w/ count, aria-live count announce, Esc closes + focus returns. Caution-not-alarm styling for
grounded. apps/web imports @aeroops/api only.

## Edge cases / tests
HEADLINE self-scoping (two members one org, disjoint reservations → disjoint alerts; A never sees B's) + T-ISO (org-A never
derives from org-B rows even for a shared tail) + reservation_upcoming as booker AND as dispatched-pilot + >24h→no upcoming +
aircraft_grounded for my reservation's tail (with reason) + grounded-but-no-reservation→NOT alerted + released grounding→drops
+ both-kinds (≤24h on grounded tail → both, distinct ids, sorted) + multi-resource (grounded one only; single upcoming) +
cancelled/voided excluded + empty→{[],0} + cap 20 (nearest kept) + sort at ASC + authz (no session→Unauthenticated) +
deterministic under injected now (boundary exactly now+24h). Pure: alertId determinism + format. Web: empty/populated/loading/
error states, badge unread math + 9+ clamp + hidden-when-seen, dismiss persists + prune, grounded row links, localStorage-
unavailable degrade, a11y. NO property tests (no engine logic).

## Compliance (light)
Read-only derived, additive (no schema/write-path/frozen-engine touch). Grounded alert = operator data (ADR-0008), NOT an
airworthiness/Part-91/43 ruling — copy says "is grounded — contact dispatch", never "not airworthy". NO money, NO computed FAA
determination (currency/medical/§61.57/Part-61/141). Self-scoping + tenant isolation adversarially tested. [VERIFY-N1-A]
provisional (surfacing operator grounding data to an affected pilot needs no extra retention/notice handling) → compliance confirm.
DEFERRED (maintainer input): persisted notifications + server mark-read + a notification table/migration; event-emission hooks;
email/SMS/push providers; staff/ops-alerts variant; more derived alert kinds.
