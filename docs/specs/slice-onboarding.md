> Note 2026-10-10: money features were removed from AeroOps; the rates and payments steps described here no longer exist (the checklist has 4 steps).

# Slice: Guided Onboarding / Setup

Status: BUILD-COMPLETE (awaiting human review). Branch `slice/code-health-rows-helper`.
No migration. Read-only backend aggregate + web UI.

## Goal

Make an AeroOps operation easy to set up, scaling from a 2-plane flying club to a
large academy. Maintainer direction: "make the software customizable to large-scale
operations and also small flying clubs, easy to setup."

A guided checklist tells an admin what their org has configured and links each
step to the REAL surface that configures it — essentials front-and-centre,
optional depth below.

## Scope (built)

### Backend — `packages/api/src/onboarding/get-onboarding-status.ts`

`getOnboardingStatus(session)` / `getOnboardingStatusWithDb(db, session)` — a
DERIVED read (no onboarding table, no migration). Barrel-exported from
`packages/api/src/index.ts`.

- **Cap:** `org:manage_settings` (owner/manager) — setup is an admin task.
  `requireCapability` FIRST, before any data access.
- **Tenant isolation:** `org_id` from session only; every COUNT runs inside
  `withSessionOrgContextWithDb` (RLS GUC on the tx). No cross-org read possible.
- **House patterns:** `*WithDb` + wrapper, `extractRows`, raw `sql`` COUNT(*)::int`,
  ISO strings + `::timestamptz` where a timestamp literal is needed (never a JS Date).

Steps (typed checklist):

| key            | essential | done when                                            | count |
|----------------|-----------|------------------------------------------------------|-------|
| `aircraft`     | ✅        | ≥1 active `resource` where `kind='aircraft'`         | active aircraft |
| `people`       | ✅        | >1 active `app_user` (`status='active'`)             | active members |
| `base_airport` | optional  | ≥1 `location` with BOTH latitude AND longitude       | coord-bearing bases |
| `rates`        | optional  | ≥1 `rate_schedule`                                    | rate schedules |
| `policies`     | optional  | ≥1 `booking_policy`                                   | booking policies |
| `payments`     | optional  | `qbo_connection.status='connected'` OR a `stripe_customer` exists | providers (0-2) |

`people` requires **more than one** active member — the sole seeded owner alone
is not "invited your team". `base_airport` requires coords (an ICAO-only base is
not enough for the twilight calc). `payments` makes NO external call — it only
inspects the org's own connection records.

Aggregates returned: `essentialDone` (aircraft && people), `optionalDone`,
`essentialCount`/`essentialTotal`, `doneCount`/`totalCount`,
`percentComplete` (= round(doneCount / totalCount × 100)).

### Web

- **`/o/[slug]/(shell)/setup/page.tsx`** — "Set up your operation" (gate
  `org:manage_settings`; redirect on forbidden/login). Progress card
  ("Essentials complete — you can start scheduling" once aircraft+people exist,
  else "X of Y steps set up" + percent + bar), an Essentials group and an
  Optional group. Each step: done/not-done icon, essential/optional badge,
  one-line description, a "Do it" link to the real surface (Fleet, People +
  "import a roster", base-airport via Fleet, Billing rates, Schedule, Settings),
  a done-note with the count, and an all-done celebratory panel. `setup/loading.tsx`
  Suspense skeleton.
- **Dashboard setup banner** — `setup-banner.tsx` (client, dismissible via
  localStorage). Rendered by the dashboard page ONLY when
  `!onboarding.essentialDone` AND the viewer holds `org:manage_settings`. Hidden
  once essentials are done. Best-effort: any fetch failure just hides it.
- **Surfacing** — a "Set up your operation" card links from the org **Settings**
  page (following the `/billing/reports` precedent — NO new `NAV_ITEMS` entry, so
  `apps/web/lib/nav.ts` and its per-role test are untouched).

### Tests — `packages/api/src/__tests__/onboarding-api.test.ts` (25 tests, PGlite)

Cap matrix (owner/manager pass; dispatcher/cfi/mechanic/renter/student/accountant
refused; null → Unauthenticated); brand-new empty org (all-incomplete, people=1
not done, no NaN); reality (add aircraft → done+count; essentialDone flips only
when aircraft AND >1 member; base_airport needs coords; rates/policies/payments;
100% path); percentComplete math; T-ISO (org-B fully configured, org-A session
still all-incomplete).

## Deferred (explicitly out of scope)

- An interactive multi-step wizard with inline forms (setup happens on the real
  surfaces; this slice guides + links, it does not embed the forms).
- Sample-data / demo seeding from the setup page.
- Per-module enable/disable customization (turning hubs on/off per org).
- White-label / terminology settings (rename "aircraft" → "gliders", etc.).
- Guided product tours / coach-marks.
- Persisting explicit "skip"/"mark done" overrides (status is derived from real
  data only — there is no onboarding state table).
