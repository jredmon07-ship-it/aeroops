# Slice P1.5 — Maintenance-due reminders

Status: BUILD-COMPLETE (awaiting human review/merge). Branch `slice/code-health-rows-helper`.
Migration `0029_maintenance_due.sql` STAGED, human-gated, NOT applied. No reviewer/compliance
sub-agent pass per the standing P1 session rule (`docs/ROADMAP.md`) — founder
reviews the diff personally.

## HARD COMPLIANCE LINE (verbatim, matches Slice 3b grounding / Slice M1 work orders)

`maintenance_item` and everything built on it are **OPERATOR-ENTERED tracking data and
arithmetic reminders** — the software computes NO Part-43/91.409/airworthiness or
inspection-due DETERMINATION of any kind. A mechanic/IA still makes the airworthiness call.
`evaluateMaintenanceDue` (`@aeroops/core`) is pure ARITHMETIC: it subtracts an operator-entered
threshold from a recorded meter/date and buckets the result into
`ok` / `due_soon` / `overdue` / `unknown`. That bucket is a heads-up, not a regulatory verdict.
The last-recorded Hobbs/tach meter it compares against is **read DISPLAY-ONLY** from the
existing dispatch-ticket history (`fleet/internal.ts loadCurrentMeters`/`loadCurrentMetersBatch`)
— this slice never recomputes, corrects, or writes a meter reading, and never touches the
dispatch meter WRITE paths (`open-dispatch.ts` / `close-dispatch.ts` / the
`dispatch_ticket_correction` table) — those remain byte-identical (verified: `git diff HEAD --
packages/api/src/dispatch/open-dispatch.ts` and `close-dispatch.ts` are both empty).
[VERIFY-P1.5-A]

## Scope (in this slice)

Operators define per-aircraft maintenance items that come due either by:
- an **hours** threshold, against the aircraft's last-recorded Hobbs *or* tach meter (operator
  picks the basis at creation, write-once), or
- a **date** threshold (a plain calendar date, e.g. "annual inspection due 2027-03-01").

AeroOps shows what's due/overdue/coming-up (list + dashboard tile + a per-aircraft facet on
Fleet detail) and can send a best-effort, staff-triggered email heads-up to the org's
owner/manager members. There is no cron in this slice — "notify" is a manual action.

## Schema (migration 0029, strictly additive)

`maintenance_item` (`packages/db/src/schema/maintenance-item.ts`): `id`, `org_id`, `resource_id`
(composite FK → `resource`, RESTRICT), `title` (nonempty CHECK), `track_by` TEXT CHECK
(`'hours'|'date'`, write-once — mirrors `rate_schedule.rate_kind`'s TEXT+CHECK posture, not a
pgEnum), `meter_basis` TEXT CHECK (`'hobbs'|'tach'`, nullable, write-once), `due_value_hours`
numeric(10,1) nullable, `due_date` date nullable, `warn_threshold_hours` numeric(10,1) nullable,
`warn_lead_days` integer nullable, `notes`, `active` boolean default true, `created_by`
(composite FK → `app_user`, RESTRICT, write-once), `created_at`/`updated_at`.
`maintenance_item_shape_check` is the structural guarantee (mirrors
`squawk_resolved_shape_check` / `work_order_completed_shape_check`):
`track_by='hours' ⇒ meter_basis + due_value_hours NOT NULL, due_date NULL`;
`track_by='date' ⇒ meter_basis + due_value_hours NULL, due_date NOT NULL`. Non-negativity CHECKs
on all three numeric fields. `UNIQUE(id,org_id)` + standard 4-policy mutable RLS (ENABLE+FORCE)
+ grants to `aeroops_app`, mirroring the byte-pattern of 0006/0013/0019.

### No completion-history table (deliberate, documented deviation from the optional spec item)

The spec offered an optional `maintenance_item_completion` append-only table. **Not built.**
`markMaintenanceItemServiced` (`packages/api/src/maintenance/mark-maintenance-item-serviced.ts`)
simply advances `due_value_hours`/`due_date` on the existing row via a guarded UPDATE and writes
**one** `audit_log` row (`action='maintenance_item.serviced'`, metadata carries the old + new
threshold + an optional note). `audit_log` already gives a durable, queryable servicing history
without a second table — this keeps the migration and the write paths simpler for a P1 slice
with no reporting requirement yet on service history. **Deferred forward seam**: a dedicated
completion-history table becomes worth building if/when a "maintenance log report" surface is
requested (parts/labor tracking would likely arrive at the same time).

## Core (pure, property-tested)

`evaluateMaintenanceDue(item, currentMeters, today)` (`packages/core/src/maintenance/
maintenance-due.ts`) — NEVER throws, deterministic, no `Date.now()`/`Math.random()`:

- `'hours'`: `remaining = dueValueHours - currentMeter(basis)`. `overdue ⇔ remaining <= 0`;
  `due_soon ⇔ warnThresholdHours set AND 0 < remaining <= warnThresholdHours`; else `ok`.
  `currentMeters === null` or the basis's own reading is `null` (no closed dispatch ticket has
  ever recorded it) → `'unknown'` — never treated as due, never a crash.
- `'date'`: `remainingDays = dueDay - todayDay`, compared as **UTC calendar days only**
  (DST-/time-of-day-agnostic — both dates are reduced to their UTC Y/M/D components before
  subtracting). `overdue ⇔ remainingDays <= 0`; `due_soon ⇔ warnLeadDays set AND
  0 < remainingDays <= warnLeadDays`; else `ok`.
- Malformed/inconsistent item shapes (should already be prevented by the DB CHECK + Zod) fail
  safe to `'unknown'` rather than crash or silently report `'overdue'`.

Property tests (`packages/core/src/__tests__/maintenance-due.test.ts`, 17 tests, fast-check):
monotonicity for both bases (a status can only move `ok → due_soon → overdue`, never backward,
as the meter increases or `today` advances), boundary correctness at `remaining/remainingDays ==
0` and `== warnThreshold/warnLeadDays`, null-safety over arbitrary malformed input (never
throws), purity, plus unit tests for month/year-boundary date arithmetic and the DST-agnostic
same-calendar-day-different-time-of-day case.

## API (`packages/api/src/maintenance/`)

Reuses the **existing** maintenance capabilities — no new capability added:
- `maintenance:access` (read) — `listMaintenanceDue`, `getMaintenanceDueSummary`.
- `maintenance:work_order` (write) — `createMaintenanceItem`, `updateMaintenanceItem`,
  `deactivateMaintenanceItem`, `markMaintenanceItemServiced`, `notifyMaintenanceDue`. This is
  the same cap that already gates work-order writes (owner/manager/dispatcher/mechanic; NOT
  cfi/accountant/renter/student) — maintenance items are the same class of operator maintenance
  record.

All write paths follow the house `*`/`*WithDb` pattern: `requireCapability` FIRST → Zod validate
(incl. the `track_by`/`meter_basis`/`due_value_hours`/`due_date` shape invariant as an
app-layer backstop before the DB CHECK) → `withSessionOrgContextWithDb` → guarded write → one
`audit_log` row per mutation (`maintenance_item.created`/`.updated`/`.deactivated`/`.serviced`).
`deactivateMaintenanceItem` is idempotent (already-inactive → `alreadyInactive:true`, **no** new
audit row — mirrors `unGroundAircraft`'s `alreadyReleased` posture).

`listMaintenanceDue({resourceId?})` loads active items (optionally scoped to one aircraft),
batches the aircraft's last-recorded meters via the new `loadCurrentMetersBatch`
(`packages/api/src/fleet/internal.ts` — an additive, N+1-avoiding sibling to the existing
single-resource `loadCurrentMeters`; DISPLAY-ONLY, same "latest closed dispatch ticket" query
shape), runs each item through `evaluateMaintenanceDue`, and sorts
`overdue → due_soon → unknown → ok` (title ASC as a stable tiebreak) — `'unknown'` is placed
ahead of `'ok'` so an operator notices an item with no recorded meter yet rather than it being
buried at the bottom. `getMaintenanceDueSummary()` reuses the exact same load+evaluate helper
(`loadMaintenanceDueViews`, exported internally for reuse, not part of the public `@aeroops/api`
surface) and reduces it to point-in-time counts for the dashboard tile.

`notifyMaintenanceDue({resourceId?})` — a **manual, staff-triggered** action (no cron; scheduling
infra is a founder/deploy concern per `docs/ROADMAP.md`). Loads the current
overdue+due_soon items via the same shared helper; if none are due it short-circuits with all-zero
counts and **no** recipient query, **no** sends. Otherwise it resolves active
`membership.role IN ('owner','manager')` members in the org and calls the existing
`sendNotificationWithDb` (`packages/api/src/notifications/send-notification.ts`, unmodified,
never-throws) once per recipient with the bounded (≤10) due-item list. Each recipient's
send is independent — one failure never blocks another, and the command itself never throws
(mirrors `sendNotification`'s own best-effort contract).

## Notifications

New event type `'maintenance.due'` (`packages/api/src/notifications/email-event-types.ts`) +
its `MaintenanceDueData` template-data shape + pure renderer (`templates.ts`,
`renderMaintenanceDue` — plain operator-operational copy, verbatim disclaimer: "This reflects
thresholds you set — it does not by itself determine airworthiness; a mechanic makes that
call."). Wired into the web notification-preferences UI's event-label map
(`apps/web/app/o/[slug]/(shell)/notifications/_utils/event-labels.ts`).

## Web (`apps/web/app/o/[slug]/(shell)/maintenance/`)

- `due-actions.ts` — server-action wrappers over the seven API commands (auth-error mapping,
  Date→ISO serialization at the RSC/client boundary), following the house `maintenance/actions.ts`
  / `maintenance/work-orders/actions.ts` pattern exactly.
- `/maintenance/due` — org-wide list page (aircraft + status filters, create/edit/mark-serviced
  dialogs, a deactivate confirm, a "Notify owners/managers" button — all write actions gated on
  `maintenance:work_order`). Verbatim compliance banner rendered above the table.
- Fleet detail facet (`fleet/_components/maintenance-due-card.tsx`, wired into
  `fleet/[id]/page.tsx` alongside the existing `OpenWorkOrdersCard`) — the due items for that one
  aircraft, fetched separately from `AircraftDetail` (a new `listMaintenanceDueAction({resourceId})`
  call added to the page's existing `Promise.all`, additive — `assembleAircraftDetail` /
  `AircraftDetail` themselves are untouched) with the same create/mark-serviced/deactivate
  actions, gated on the existing `canWorkOrder` prop (`maintenance:work_order`).
- Dashboard tile (`/o/[slug]` — `page.tsx`) — a 7th snapshot-strip tile, **additively appended**
  after "Active enrollments" (the existing 6 tiles are byte-unchanged; the loading skeleton's
  tile count was bumped 6→7 to match). Fails closed to an em-dash "not available" state (rather
  than an error) for any role with `reporting:access` but not `maintenance:access` — no such role
  exists in the current matrix, but this mirrors the documented Slice 7 at-a-glance-lists
  fail-closed posture for future-proofing. `getOrgDashboardMetrics`/`getAircraftUtilization` and
  every existing reporting read are completely untouched.

## Tests

- `packages/core/src/__tests__/maintenance-due.test.ts` — 17 tests (6 fast-check property + 11
  unit) for the pure evaluator.
- `packages/api/src/__tests__/maintenance-due-api.test.ts` — 34 integration tests (PGlite,
  migrations 0000–0029): capability matrix (write cap + read cap, incl. `UnauthenticatedError`);
  create (both track-by variants, all four shape-invariant violations, non-aircraft/inactive/
  cross-org resource, empty title); update (happy + audit row, cross-org → `not_found`,
  wrong-basis-field rejection, empty-update rejection); deactivate (happy + audit row, idempotent
  no-audit-on-repeat, cross-org → `not_found`); mark-serviced (both variants + audit row,
  wrong-basis-field rejection, cross-org → `not_found`, and an end-to-end "overdue → serviced →
  ok" re-list assertion); `listMaintenanceDue` (classification against seeded closed-dispatch
  meters, a **null-meter aircraft** with no closed ticket → `'unknown'` never a crash, the
  resourceId filter, the sort order, inactive-item exclusion); `getMaintenanceDueSummary`
  (counts consistent with `listMaintenanceDue`); a T-ISO test (cross-org invisibility via both
  the API read and a raw RLS-scoped SELECT); `notifyMaintenanceDue` (owner/manager-only
  recipients verified by exact user-id inclusion/exclusion against dispatcher/cfi/mechanic/renter,
  the zero-due short-circuit, and its own authz gate); and a pure render test for the
  `'maintenance.due'` template.
- Baseline before this slice: 3,822 tests (core 1,042 + api 1,637 + web 615 + db 528). After:
  core 1,059 (+17) + api 1,671 (+34) + web 615 (+0) + db 528 (+0) = **3,873** (+51), all green.

## Deferred (forward seams only — flag `[VERIFY]` when picked up)

- **AD (Airworthiness Directive) tracking** — a distinct regulatory-lookup surface; NOT built
  here, and NOT something this arithmetic-only slice should grow into without a dedicated
  compliance pass.
- **Recurring-interval auto-advance rules** (e.g. "always 100 hours after the last service" as a
  standing rule rather than an operator-typed new threshold each time) — `markMaintenanceItemServiced`
  requires the operator to type the next threshold explicitly in this slice; an auto-advance-by-N
  rule is a natural but separate follow-up.
- **Parts inventory** — no parts/labor tracking; `notes` is free text only (mirrors Slice M1's
  `work_performed`/`sign_off_notes` posture).
- **Per-item document attachments** — no file/photo attach on a maintenance item in this slice
  (document storage is a separate P1 roadmap item, `docs/ROADMAP.md` §6, and remains
  "stored never interpreted" even once built).
- **Completion-history table** — see the "No completion-history table" section above.
