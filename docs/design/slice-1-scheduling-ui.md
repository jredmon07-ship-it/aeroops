# AeroOps Slice 1 — Scheduling UI Spec

**For:** frontend-engineer
**Date:** 2026-06-16
**Scope:** Slice 1 ONLY — resources + reservations + conflict detection.
**Out of scope:** drag-and-drop calendar grid, recurring bookings, dispatch check-in/out, Hobbs/tach, optimizer, civil-twilight, mobile.
**Backend contract:** `@aeroops/api` scheduling module (already built).
**Design system:** Tailwind + existing shadcn/ui primitives in `apps/web/components/ui/`. Per-tenant tokens via CSS custom properties in `globals.css`.

---

## 1. Screen Inventory and Routes

All routes live under the existing authenticated shell at `/o/[slug]/`. Middleware gates every `/o/[slug]/*` route on session + slug-match. RBAC is enforced server-side by `requireCapability` in every server action; `hasCapability` is used in server components for conditional rendering only (never the sole gate).

| Route | Screen | Capability | Purpose |
|---|---|---|---|
| `/o/[slug]/schedule` | Reservations List | `schedule:access` | Day/date list of reservations |
| `/o/[slug]/schedule/new` | New Reservation | `schedule:create_reservation` | Full-page booking form with live conflict preview |
| `/o/[slug]/schedule/resources` | Resource Admin | `schedule:manage_resources` | CRUD list of aircraft + instructors |

Cancel is a dialog from the list, not a route. New reservation is a dedicated page (live async conflict preview needs room).

---

## 2. Shell Integration

Add to the shell nav (server component, gated by `hasCapability`, UI-only):

```
Schedule        (shown if schedule:access)
  Reservations  → /o/[slug]/schedule
  Resources     → /o/[slug]/schedule/resources   (shown if schedule:manage_resources)
```

Roles with neither capability (mechanic, renter, student, accountant) see no scheduling nav.

---

## 3. Reservations List — `/o/[slug]/schedule`

**Data:** `listReservations(session, { from: startOfDay(date), to: endOfDay(date) })`. Resource names resolved by fetching `listResources(session, {})` in parallel → `Map<id, displayName>`. Deactivated-after-booking resources render "Unknown resource" (`text-slate-400 italic`). Cancelled hidden by default (`includeCancelled: false`).

**Layout:** Top bar (`<h1>` "Schedule" + "+ New Reservation" right-aligned, shown only with `schedule:create_reservation`). Date control bar: Prev / Today / Next + date label (`role="toolbar"`, ArrowLeft/Right shortcuts, `<output aria-live="polite">`). Reservation cards ordered by `startAt`: time range `HH:mm – HH:mm` (local 24h), resource names (aircraft before instructor), notes (`text-slate-500 text-sm`), status `Badge` (booked=default sky, cancelled=secondary), Cancel button (`outline size="sm"`, only if `schedule:create_reservation` AND status booked).

**States:**
- Loading: 3 `<Skeleton>` rows (`h-16`) behind `Suspense`.
- Empty: calendar icon + "No reservations on this date." (+ "Book one with + New Reservation above." if can create).
- Error: `Alert variant="destructive"` "Could not load reservations. Try refreshing the page."
- No permission: server redirect to `/o/[slug]/no-access` (requireCapability throws ForbiddenError).

**First-run banner:** if `listResources` is empty AND user has `schedule:manage_resources`, show info `Alert` atop the list: "No resources have been added yet. Add aircraft and instructors before creating reservations." linking to `/schedule/resources`.

**A11y:** each card is `<article aria-label="Reservation [time], [resources], [status]">`; badges show text not color-only; cancel button `aria-label="Cancel reservation [time range]"`. Mobile: single column, control bar wraps, 44px touch targets.

---

## 4. New Reservation — `/o/[slug]/schedule/new`

Client component (`'use client'`) fed resources as props from the RSC page (`listResources(session, {})`).

**Fields:**
- **Date** — `<input type="date">`, required, defaults to `?date=` query param or today.
- **Start / End** — `<input type="time" step="300">`, required, side-by-side at `sm:`. Inline error under End: "End time must be after start time."
- **Aircraft** — `<select>` of active `kind==='aircraft'` ordered by displayName, first option `— Select —`. **Instructor (optional)** — `<select>` of active `kind==='instructor'`. Slice-1 uses single-value selects (one aircraft + optional instructor); send `[aircraftId]` or `[aircraftId, instructorId]`. At least one resource required → "Select at least one resource."
- **Notes** — `<textarea rows="3" maxlength="500">`, optional.

**Live conflict preview (`checkConflicts`):** debounced 400ms via `useConflictCheck`; fires only when date+start+end set, end>start, ≥1 resource. Banner states:
1. Hidden (incomplete form).
2. Checking — `Alert` + `Loader2` "Checking availability…" (`aria-live="polite"`).
3. Clear — `CheckCircle2 text-green-600` "This time slot is available for all selected resources." (`aria-live="polite"`).
4. Conflict — `Alert variant="destructive"` `XCircle` "This time slot has conflict(s):" + bullets "[resourceDisplayName] is booked [HH:mm] – [HH:mm]" from each `ConflictHit` (`aria-live="assertive"`).
5. Preview error — "Availability check failed. You can still try submitting." Submit stays enabled.

Submit button is NOT disabled during preview (avoid blocking on stale preview).

**Submit (`createReservation`):** client-validate first (focus first invalid). Then loading "Booking…".
- **ok:true** → redirect to `/o/[slug]/schedule?date=[date]&success=1`; list renders dismissible success `Alert` "Reservation booked for [date] [start]–[end]."
- **ok:false conflict** → same destructive banner, copy "This reservation could not be booked because of a conflict:" + bullets. Button re-enabled.
- **ValidationError thrown** → top `Alert variant="destructive"` "Invalid reservation: [message without `[scheduling]` prefix]"; fields retained; focus alert.
- **Server/network error** → "Something went wrong. Please try again."

**Dirty-form guard:** leaving with non-empty fields → `AlertDialog` "Discard reservation?" / "Keep editing" (autofocus) / "Discard" (destructive). Pristine → navigate immediately.

**First-run (no resources):** render empty state instead of form — PlaneTakeoff icon + "No resources to book yet." + "An administrator must add at least one aircraft or instructor before you can create a reservation." + (if `schedule:manage_resources`) "Add a Resource" button → `/schedule/resources`.

**A11y:** `<h1>` "New Reservation"; autofocus Date; labels with `htmlFor`; required `aria-required`; inline errors `role="alert"` + `aria-describedby`; banner `role="status"`/`role="alert"` per state. Mobile: stacked fields, buttons stack (Cancel top, Book bottom).

---

## 5. Resource Admin — `/o/[slug]/schedule/resources`

Requires `schedule:manage_resources` (owner, manager, dispatcher). Backed by `listResources(session, { includeInactive: true })`, split into aircraft/instructors × active/inactive.

**Layout:** `<h1>` "Resources" + "+ Add Resource". Button-based tabs "Aircraft (n)" / "Instructors (n)" (`role="tablist"`, arrow-key nav, no Radix needed). Active section then Inactive section. Each row = compact `Card p-4`: aircraft tail in `font-mono text-sm` + displayName; instructor displayName; status `Badge` (Active=default, Inactive=secondary); "Deactivate" (`outline size="sm"`) on active rows only.

**States:** Loading 3 `<Skeleton h-14>`; per-tab empty states (PlaneTakeoff/"No aircraft added yet."; UserCheck/"No instructors added yet."); error `Alert`; no-permission redirect.

**Add Resource (Dialog):** opens `Dialog` (new primitive). Fields: **Kind** `<select>` (Aircraft default / Instructor); **Display name** `<Input maxlength=100>` (placeholder per kind); **Tail number** (`<Input>`, shown when Aircraft, required, validate N-number — `[VERIFY]` FAA format, start `^N[0-9]{1,5}[A-Z]{0,2}$`); **Instructor user** `<select>` of CFI members (shown when Instructor, required) — **populated via `listOrgMembers` (see §10)**. Kind switch clears the conditional field. Submit → `createResource`; success closes + inline success `Alert` "Resource added."; ValidationError → inline field error; submitting → disabled + "Adding…".

**Deactivate (AlertDialog):** Title "Deactivate [name]?", Description "This resource will no longer be available for booking. Existing reservations are not affected. This cannot be undone from this interface." Cancel "Keep active" (autofocus) / Action "Deactivate" (destructive). `deactivateResource({resourceId})`: ok:true → move row Active→Inactive + `aria-live` "[name] deactivated."; not_found → "Resource not found. It may have already been removed." Soft-delete copy — never "permanently deleted".

**A11y:** standard ARIA tabs; deactivate `aria-label="Deactivate [name]"`; dialog focus management mirrors existing `alert-dialog.tsx`. Mobile: stacked rows, full-width tabs.

---

## 6. Conflict Banner Copy

Advisory: "This time slot is available for all selected resources." / "This time slot has conflict(s):" + bullets. Hard (on submit): "This reservation could not be booked because of a conflict(s):". Adjacent times (`[)`): correctly shows available — no special copy; optional tooltip "Reservations that end at your start time do not conflict."

---

## 7. Confirmations

| Action | Confirm | Dialog | Safer default |
|---|---|---|---|
| Cancel reservation | Yes | AlertDialog | "Keep reservation" |
| Deactivate resource | Yes | AlertDialog | "Keep active" |
| Create reservation | No | — | — |
| Add resource | No | — | — |
| Leave dirty new-reservation form | Yes | AlertDialog | "Keep editing" |

Cancel reservation copy: Title "Cancel this reservation?", Description "This will cancel the [start]–[end] reservation for [resources]. This action is recorded." Cancel "Keep reservation" / Action "Cancel reservation" (destructive).

---

## 8. Component & File Plan (paths under `apps/web/`)

**New ui primitives:** `components/ui/dialog.tsx` (Radix `@radix-ui/react-dialog`, mirror `alert-dialog.tsx`), `components/ui/textarea.tsx`, `components/ui/tabs.tsx` (button-based), and styled native `<select>` (or `components/ui/select.tsx`).

**Server actions:** `app/o/[slug]/(shell)/schedule/actions.ts` — `listReservationsAction`, `createReservationAction`, `cancelReservationAction`, `checkConflictsAction`, `listResourcesAction`, `createResourceAction`, `deactivateResourceAction`, `listOrgMembersAction`. Each calls `auth()` then the `@aeroops/api` fn; map ForbiddenError/UnauthenticatedError/ValidationError to `{error}` shapes; pass through `ok:false` conflict results.

**Pages (RSC):** `schedule/page.tsx`, `schedule/new/page.tsx`, `schedule/resources/page.tsx`.

**Client components:** `_components/reservation-list.tsx`, `reservation-card.tsx`, `cancel-reservation-dialog.tsx`, `date-nav.tsx`; `new/_components/new-reservation-form.tsx`, `conflict-banner.tsx`; `resources/_components/resource-list.tsx`, `resource-row.tsx`, `add-resource-dialog.tsx`, `deactivate-resource-dialog.tsx`.

**Hook:** `new/_hooks/use-conflict-check.ts` (400ms debounce → `{ state, conflicts }`).

**Utils:** `_utils/format-time.ts` (`formatTimeRange`, `formatDate`), `_utils/resource-map.ts` (`buildResourceMap`).

---

## 9. Tokens

Use token-mapped classes (`bg-brand`, `text-brand`, `bg-surface`, `border-border`, `bg-danger`) over hard-coded `sky-600`/`red-600` in NEW components. Do not refactor existing components. Org logo lives in the shell nav.

---

## 10. Backend Contract Notes

1. **`listOrgMembers` — REQUIRED, being built:** `listOrgMembers(session, { role?: MembershipRole[] }) → { userId, displayName, email, role }[]`, cap `schedule:manage_resources`. Powers the instructor picker in Add Resource. (Routed to backend-engineer.)
2. Minor — render `tailNumber` (`font-mono`) + `displayName` together in resource rows; no API change.
3. Minor — list view resolves resource names via parallel `listResources`; acceptable for Slice 1.
4. Note — `createdBy` is a UUID; not displayed in Slice 1.

---

End of spec.
