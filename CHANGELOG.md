# Changelog

All notable changes to AeroOps are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); the project follows
[Semantic Versioning](https://semver.org/).

## 2026-10-14 — Security updates: Next.js, Auth.js, sharp

Patch releases of the web framework and the sign-in library. No migration.

**Security**

- Next.js 15.5.19 → 15.5.28. Fixes remote code execution in the image optimizer through SVG and
  AVIF files (GHSA-2464-fhr4-w9xw, GHSA-2xp9-vwfh-vxw4), denial of service through Server Actions
  (GHSA-p3m5-59mp-jv5r, GHSA-m99w-x7hq-7vfj), and the other advisories against 15.5.19. The image
  optimizer runs only on a self-hosted server (`pnpm start`); Vercel serves images itself. Its
  image library, sharp, goes 0.34.5 → 0.35.5 (libvips, libheif and librsvg fixes).
- Auth.js: next-auth 5.0.0-beta.31 → beta.32 and @auth/core 0.41.2 → 0.41.3. When Auth.js
  answers with an error, such as a configuration error, server-side `auth()` now returns no
  session instead of the error object, which a check like `if (!session)` let through
  (GHSA-8fpg-xm3f-6cx3). The other fixes (email sign-in, `getToken()`, OAuth checks) are in code
  AeroOps does not use.
- `packages/api` no longer installs a second Next.js (16.2.9) and React (19.2.7) to satisfy
  next-auth's peer dependency. It resolves the web app's Next.js 15.5.28 and React 19.1.0 instead.
  The extra copy was never loaded.

## 2026-10-14 — Signed-in sessions follow password resets and role changes

A password reset now signs the member out of every browser, and a role change reaches someone
who is already signed in. No migration.

**Changed**

- Setting a password through a login link signs that member out of every browser they were
  signed in on, within 15 seconds. Phones were already signed out (mobile refresh sessions are
  revoked). The same check signs a browser out when the membership row is gone or the org is
  suspended (both changed outside the app today). Deactivating a member on the People page
  still does not sign them out: it stays a roster flag that sign-in does not check either.
- A role change on the People page applies to a signed-in member's browser within 15 seconds:
  their session's role is always the membership's current role, so a demoted manager loses
  `people:manage` without signing out. (The phone app already picked up role changes at its next
  token refresh, within 15 minutes.)
- How: every web session carries `cfp`, a domain-separated fingerprint of the password hash it
  signed in with (never the hash, never on the session object, not in the mobile token). On
  every server-side `auth()` the Node auth config re-reads the member's credential, membership
  role and org status in one query under `withOrgContext` and returns no session when the
  fingerprint no longer matches, the membership is gone or the org is not active
  (`packages/api/src/auth/session-revalidation.ts`). Checks are cached per server process for
  `AEROOPS_SESSION_REVALIDATE_TTL_MS` (default 15000; `0` turns the cache off; capped at 5
  minutes).
- A database error during the check fails closed for that request (the visitor gets the sign-in
  page), is logged without ids or emails, and is not cached. The edge middleware still checks
  only the cookie's signature; protected pages send a revoked session to `/o/<slug>/login`,
  which never redirects, so there is no redirect loop.
- A server action (saving a form, dragging a reservation, the alerts bell) from a browser whose
  session has ended goes to the sign-in page with a "Your session has ended" notice, instead of
  answering with "You do not have permission…" (`apps/web/lib/action-auth.ts`). Activity,
  Reports and Help, opened from the sidebar, now go to sign-in too instead of showing their
  "not available for your role" panel.
- Only a passing check is cached. A refused one is answered again on the next request, so a
  member let back in (org reactivated, membership restored) is not bounced for up to the TTL.

**Security**

- The phone app's access tokens now have their own encryption salt and a `purpose` claim. On an
  `http://` origin (`pnpm start`, a self-hosted server without HTTPS, a proxy that does not send
  `X-Forwarded-Proto: https`) the browser session cookie used the same salt, so it worked as a
  bearer token on `/api/mobile/v1/*` — where the session check above never runs, so a reset,
  removal or demotion did not reach it — and the middleware re-issued a 15-minute mobile token
  sent as the cookie for 8 hours, past the mobile session's revocation. Neither now decrypts as
  the other. HTTPS deployments (Vercel) were not affected.
- Calendar feed links are re-checked against their owner on every fetch: a removed member's
  feeds and a suspended org's feeds stop working, and an aircraft feed stops when its owner's
  role loses Fleet access (it comes back with the role). A password reset does not revoke feed
  links; the member revokes or regenerates them on the Portal page or the aircraft's Fleet page.

**Upgrade note**

- Sessions signed in before this release carry no fingerprint and are refused: everyone signs
  in once after it is deployed.
- Phone app access tokens minted before this release stop verifying. The app renews them
  through its normal refresh on the next request; nobody has to sign in again.

This replaces the "web sessions stay signed in for up to 8 hours after a reset" note in the
login-links entry below, and closes the "instant role revocation" item deferred in Slice 0.3.

## 2026-10-12 — Login links

Members added on the People page can now get a login.

**Added**

- **Create login link / Create reset link** on a member's profile (owners and managers). It
  makes a link to `/o/<slug>/login-link/<token>` that is valid for 7 days and works once. The
  operator copies it and sends it themselves; AeroOps sends no email. The member opens it,
  chooses a password (same rules as signup: 10–200 characters), and signs in with their email.
- Only an owner can create a link for an owner or manager, so a manager cannot take over a
  more privileged account. Owners can make one for themselves to change their own password.
  Deactivated members cannot get or use a link. Links are off on the shared demo orgs.
- Using a link replaces the member's password, makes every other link for them stop working,
  and signs their phones out (mobile refresh sessions are revoked). Both creating and using a
  link are written to the activity log; the link itself is never stored.

**Notes**

- No migration. The token is signed with `AUTH_SECRET` and carries a fingerprint of the
  member's current password hash, which is what makes it single-use.
- Web sessions are stateless JWTs, so a browser that is already signed in stays signed in
  until its session expires (up to 8 hours) after a reset. See `docs/specs/login-links.md`.

## 2026-10-10 — Money features removed

AeroOps is now an operations tool only: scheduling, dispatch, fleet, maintenance, training,
people, reporting, public booking requests, and mobile.

**Removed**

- Billing hub, rate schedules, invoices, the member ledger and balances, block time, recurring
  dues/tuition, counter sales (POS), fee passing, and the billing/AR/revenue reports.
- Stripe payments (saved payment methods, self-pay, auto-pay, the webhook route) and the
  QuickBooks Online integration (OAuth routes, export, sync).
- The dispatch balance arm (`balance_block`) and its seam; the pre-flight gate is now
  grounded → ineligible. The dispatch config no longer reads or writes the balance columns.
- The `billing:access` / `billing:manage` capabilities (23 → 21). The accountant role stays
  (it is a Postgres enum value) as a read-only Dashboard/Reports/Activity viewer.
- The `billing` org module, the invoice/payment/dues notification types, the rates and
  payments setup steps, the money help articles, money demo data, and money tests.
- Billing, pricing, and fee copy on the project site; the FAQ keeps plain product questions.

**Kept**

- The append-only dispatch meter correction (`dispatch_ticket_correction`) and the effective
  meter read, moved to `packages/api/src/dispatch/`.
- Every migration and the Drizzle schema for the money tables, so the live database and the
  migration history are untouched. No application code reads or writes those tables.

## [Unreleased] — Deployment + Reporting depth (post-deploy, branch `slice/post-deploy`)

**Deployed** — the full product went live on Vercel + Neon Postgres (migrations applied human-gated, demo
seeded, non-superuser `aeroops_app` role + RLS verified). Next.js 15.3.3→15.5.19 (security) + a CI
typecheck-from-source fix. (Open: set `AUTH_SECRET` in Vercel Production to clear the login.)

**Also shipped this phase (each reviewer + compliance PASS; details in `docs/specs/`):**

- **Global search (⌘K)** — a command palette searching aircraft / members / work orders / squawks / courses /
  reservations, with results scoped to the role's read capabilities (a student sees nothing), RLS-isolated and
  injection-safe.
- **Student/renter portal** (`/portal`) — a read-only self-service surface: your reservations, your training
  progress, your account. Each read is locked to the logged-in member's own data.
- **Activity feed** (`/activity`) — a read-only timeline of recent audited actions, with curated human summaries.
- **Resource availability windows** — operators set per-aircraft/instructor operating hours; booking outside them
  warns or blocks (operator scheduling rule, not a duty-time determination). Migration `0014` (human-gated).
- **In-app alerts bell** — a per-user header bell: your upcoming reservations and a heads-up when an aircraft you've
  booked is grounded. Derived read-only; nothing new persisted.
- **Public booking-request page** (`/book/[slug]`) — a public, unauthenticated lead-capture form where a prospective
  renter/student requests a flight; it lands in a staff **triage inbox** (`/o/[slug]/booking`) to contact/convert/decline.
  Conservative by design: a *request*, not an instant booking — no money, no fleet/schedule exposed.
  Migration `0015` (human-gated). **Before public launch:** add an edge rate-limiter/WAF + CAPTCHA and a lead-data
  retention posture (documented as launch predecessors).
- **Convert booking-request → reservation** — staff turn a triaged request into a real booking: pick a tail + time and
  the reservation is created through the same gated path every reservation uses (all conflict/policy/grounding/twilight/
  availability checks apply); on refusal nothing is created. Atomic + idempotent. Migration `0016` (human-gated). No money.
- **A design-language polish pass** + several tracked nit fixes; the demo seed now exercises all of the above.

### Slice R1 — Operational Reports deep-dive (build-complete, awaiting merge)

**Added**

- **An operational Reports page** (`/reporting/reports`) — a range-selectable analytics deep-dive beyond the
  dashboard snapshot: fleet utilization over time, hours by tail, reservations-vs-flights trend, and training +
  maintenance throughput trends. Five read-only, RLS-scoped aggregates with pure UTC time-bucketing; lightweight
  CSS bars (no chart dependency). The accountant role (reporting-only) now gets full data — fixing a fail-closed gap.

**Changed / Fixed**

- A design-language polish pass (brand tokens replacing stray sky-*, architectural corners, one consistent focus +
  selection system across schedule/maintenance/fleet/training). The dashboard "grounded" card now shows the real
  operator grounding reason instead of "No reason given".

**Notes**

- Reports are operational figures only — **no money, no migration, no computed FAA/Part-141/airworthiness
  determination** (verbatim hours + operator-count disclaimers carried forward). Tenant isolation adversarially
  tested on every aggregate. ADR n/a (read-only). ~2,430 tests green; reviewer + compliance PASS.

## [Unreleased] — Phase 4 (Maintenance)

### Slice M1 — Maintenance work-orders foundation (build-complete, awaiting merge)

**Added**

- **The Maintenance work-orders hub** — open a work order on an aircraft (optionally linked to a squawk),
  track it `open → in_progress → completed / cancelled`, record free-text work performed + a maintenance
  sign-off, and **close the loop**: completing a work order can (at the operator's explicit choice) resolve
  the linked squawk and **return the aircraft to service** (unground it). A `/maintenance/work-orders`
  surface (list + detail + open/start/complete/cancel) plus an "Open work orders" card on each aircraft's
  Fleet page. The grounded demo aircraft can now be returned to service through a real maintenance record.
- The completion is **atomic** — work-order completion, squawk resolution, and ungrounding run in one
  transaction (any failure rolls the whole loop back), reusing the existing squawk/grounding write paths
  unchanged. Ungrounding only releases an aircraft grounded **for this work order's reason** (never one
  grounded for something else), and is always an explicit operator action.

**Notes**

- **Work orders, sign-offs, and "completed" are operator maintenance records — the software computes NO
  FAA/Part-43 determination** (no airworthiness, return-to-service/§43.9/§43.11, AD compliance, inspection
  currency, or MEL status). A sign-off is data entry, not an A&P/IA certification or e-signature; the
  completion UI carries a verbatim disclaimer. A&P/IA credential verification, e-signature, AD/inspection-due
  tracking, parts inventory, and maintenance billing are deferred (forward seams only). New capability
  `maintenance:work_order`; ADR-0012; migration `0013` staged + human-gated. No money, no meter access.
  2,925 tests green; reviewer APPROVE (nits fixed) + compliance PASS.

## [Unreleased] — Phase 3 (Training)

### Slice T1 — Training hub foundation (build-complete, awaiting merge)

**Added**

- **The Training hub** — operators can build a course (an operator-named syllabus with ordered,
  optionally stage-grouped lessons), enroll a member, record a lesson as completed by an instructor,
  and see at-a-glance progress (completed / total). A `/training` surface (courses list + detail,
  enrollments list + the per-student enrollment detail with a per-lesson checklist and a full record
  log), plus a "Training" card on each member's People page. Recorded lessons are write-once; a
  mistake is voided (kept in the log, struck-through), never edited.

**Notes**

- **The whole hub is operator content + instructor data entry — it computes NO FAA determination.**
  Grades and stage labels are free-text; "progress" is a content-coverage ratio (not a Part-141
  completion); a lesson record is data entry, not an e-signature; enrollment "completed" is an operator
  flag, not graduation. Every regulation-adjacent surface carries a verbatim disclaimer, and the
  digitally-signed records / stage-check enforcement / 80%-completion / endorsements / qualification-
  gating are explicitly deferred (forward seams only). New capabilities `training:access` /
  `training:manage`; ADR-0011; migration `0012` staged + human-gated. No money, no meter access.
  2,780 tests green; reviewer APPROVE + compliance PASS.

## [Unreleased] — Phase 1 (Scheduling + Dispatch)

### Slice 4M — Mobile foundation: auth + schedule API (build-complete, awaiting merge)

**Added**

- **The server-side foundation for the native (Expo/iOS) app** — a token-based mobile auth + a read-only
  schedule API, built so a device never touches the database and never holds a long-lived secret.
  `POST /api/mobile/v1/auth/login` issues a short-lived (8h) signed token (same secret + claim shape as the
  web session, via the same JWT primitives) after running the **identical** password-verification pipeline
  the web uses (argon2 + anti-enumeration + org resolution — now extracted into one shared function the web
  login also calls, so there's a single source of truth). `GET /api/mobile/v1/schedule` verifies the token
  and returns the org's reservations through the existing gated read — org scoping, RLS, and capability checks
  are identical to the web. Mobile DTOs (org id never on the wire; dates as ISO strings) live in the shared
  pure package so the future app and the API agree.

**Notes**

- The auth + schedule API is fully integration-tested (login failure-matrix → one generic 401, token
  round-trip, a web-parity guard against drift, and a tenant-isolation test proving an Org-A token only ever
  returns Org-A data). The native Expo app itself and an on-device demo are the remaining mobile work — they
  need a simulator/device and (for an end-to-end demo) a deployed backend, both outside this build environment.
  No writes, no money, no schema change; the web cookie-session auth and the frozen engines are byte-untouched.

### Slice 4b — Intelligent auto-scheduler (build-complete, awaiting merge)

**Added**

- **"Build my schedule" auto-scheduler** (parity with the market's flagship intelligent-scheduling
  feature). A pure, deterministic optimizer (`proposeSchedule` — greedy with bounded backtracking)
  takes a set of desired sessions (aircraft/instructor demand, durations, a date window, priorities)
  and proposes a self-consistent schedule that respects availability, existing bookings/blackouts, and
  the civil-twilight constraint. A `/schedule/auto` flow: define demand → **Preview** (would-create /
  would-skip / unschedulable, with reasons) → explicit **Commit** (never auto-commits) → results with
  a hand-off to drag-and-drop board adjustment.
- **Propose-then-gates-dispose:** the optimizer is advisory — every proposed booking is committed
  through the existing frozen reservation write path, so it can never bypass conflict/policy/twilight
  detection. A proposal refused at commit (reality drifted, or a concurrent booking won) is reported as
  skipped while the rest of the batch commits. Each run is audited (`schedule_optimization_run` header +
  an optimization-run id on every created reservation).

**Notes**

- The optimizer is pure + property-tested (never proposes a conflicting pair, respects all handed-in
  constraints, deterministic, terminating). It schedules time and **never prices it** — no money. No new
  reservation write path; the Postgres EXCLUDE constraint remains the no-double-book backstop. Migration
  `0011` (run-header) staged + human-gated. **Slice 4 (4a civil-twilight + 4b auto-scheduler) completes
  Phase 1's planned scheduling build.** 2,240 tests green; reviewer APPROVE + compliance PASS.

### Slice 4a — Civil-twilight constraints (build-complete, awaiting merge)

**Added**

- **Civil-twilight scheduling awareness.** A pure, property-tested solar-position calculation
  (`computeSolarEvents`, NOAA/Meeus, ~1-minute accuracy vs. USNO/NOAA — sunrise/sunset + morning/
  evening civil twilight from a location's coordinates) and a warn/block twilight gate layered
  ADDITIVELY into the shared reservation create path: a booking that crosses civil dawn/dusk can
  warn (advisory) or block per an operator setting. INERT by default, and inert for any aircraft
  without home-base coordinates — so existing bookings are unaffected.
- **Operator config + UI:** civil-twilight controls (enable, warn/block, a free-text "night-qualified"
  exempt-tag seam) on the dispatch-board Gate Settings; a day/night indicator on the new-reservation
  form showing daylight/twilight status (and explicit polar-day/polar-night/no-civil-twilight copy).
  Additive `location.latitude`/`longitude` + `dispatch_config` twilight columns (migration 0010).

**Notes**

- **Civil twilight is computed as ASTRONOMY and surfaced as an operator scheduling rule — it is NOT
  an FAA night-currency / §61.57 / §1.1 determination** (compliance-confirmed; the UI carries a verbatim
  disclaimer). "Night-qualified" is a free-text operator label; exemption enforcement is deferred. No
  money. The frozen conflict/policy/recurrence engines and the existing create-path refusal arms are
  byte-identical. Migration 0010 staged + human-gated. 2,199 tests green; reviewer APPROVE + compliance PASS.

### Slice 3c — Full pre-flight (dispatch) gate (build-complete, awaiting merge)

**Added**

- **The dispatch check-out gate is now complete** — additively layered as
  **grounded → ineligible → balance**: an operator can require **free-text tags** on the dispatched
  pilot per aircraft (a pure, property-tested matcher — string membership only, computing NO FAA
  currency/medical/endorsement), with a block-or-warn mode. A grounded aircraft still refuses first.
- **Operator config:** a `dispatch_config` row (eligibility mode; a balance-check feature flag) +
  per-aircraft `dispatch_requirement` rows. New `dispatch:manage_requirements` capability
  (owner/manager/dispatcher). UI: a "Dispatch requirements" card on each aircraft's Fleet detail page,
  a "Gate settings" control on the dispatch board, and an `ineligible` message (listing the missing
  tags) in the check-out dialog.
- **Balance seam (stub only — money boundary held):** a `BalanceSeam` interface + a no-op
  `stubBalanceSeam` that always returns OK. The `balance_check_enabled` flag is OFF by default and the
  toggle is labeled "not yet active." **No Stripe, no payment data, no dollar value** — the real balance
  check is Phase 2; this is purely the seam so it can be wired without touching the gate.

**Notes**

- `openDispatch`'s existing arms (`not_found`/`already_open`/`grounded`) are byte-identical; the new
  arms are additive. Eligibility blocking is the operator enforcing their own rule, not a software
  airworthiness/currency determination (compliance-confirmed). Migration `0009` staged + human-gated
  (applied in-memory by the demo). 2,114 tests green; reviewer APPROVE + compliance PASS.

### Slice 7 — Reporting / Ops Dashboard (build-complete, awaiting merge)

**Added**

- **The landing page is now a real ops console** (replaces the Phase-0 placeholder). It opens on
  an "As of now" snapshot strip (grounded aircraft, open squawks, active aircraft, active members)
  visually separated from "Last N days" KPIs (flights, flight hours, reservations), a per-tail
  **fleet utilization table** (flight count + hours + proportion bars), and "On the board"
  at-a-glance lists (today's flights, currently grounded, open squawks) — all deep-linked to the
  relevant hub. A 7/30/90-day range selector (server-driven, no client fetch).
- **Reporting API** (read-only, no schema): `getOrgDashboardMetrics` (the headline metrics) and
  `getAircraftUtilization` (per-tail hours/flights), plus a pure `resolveRange` helper. New
  `reporting:access` capability (owner/manager/dispatcher/cfi/accountant).

**Notes**

- Designed by the product-designer (a two-tier "now vs. period" visual grammar so a snapshot count
  can't be misread as a range figure), then built to that spec. Hours are framed as OPERATIONAL
  utilization — never a billing or airworthiness figure; **no money anywhere**. Tenant isolation on
  every aggregate was adversarially verified (the `T-ISO-*` suite seeds a second org with more of
  every metric and asserts the first org sees only its own). ~1,975 tests green; reviewer
  APPROVE-WITH-NITS + compliance PASS. No new migration.

### Slice 6 — People / Members management (build-complete, awaiting merge)

**Added**

- **People hub.** A real members surface: `listMembers` (roster with role, status, free-text
  tags) and a per-member `getMemberDetail` aggregating role + tags + the reservations they
  booked (`created_by`) + recent dispatch where they were the pilot + whether they have login
  access (`hasLogin`, existence-only — the password hash is never read). `updateMember`
  (identity + role, audited) and `setMemberStatus` (active/inactive) both guard against
  removing the last active owner and against self-deactivation. `addMember` creates a
  **roster entry only** (no login/credential until a future invite slice).
- **Free-text member tags.** New `member_tag` table + `addMemberTag` / `removeMemberTag`
  (audited). Tags are **opaque operator labels ONLY** — the system computes/interprets no FAA
  currency, medical, or Part 61/141 eligibility from them. This is the admin surface the
  deferred eligibility follow-up will later read; enforcement is still out of scope. Additive
  `app_user` columns `phone` + `status` (`status` is a roster flag, NOT a login gate).
- **RBAC.** New `people:access` (owner/manager/dispatcher/cfi) and `people:manage`
  (owner/manager). People UI: `/people` list + `/people/[id]` detail + edit / add / status /
  tag-editor dialogs + nav item.

**Notes**

- Built via a multi-agent **Workflow** with an adversarial review panel: a dedicated
  tenant-isolation auditor actively tried to break org isolation through the aggregation and
  the tag mutations and found none (verdict: SAFE), alongside reviewer APPROVE + compliance
  PASS. Migration `0008` staged + human-gated (applied in-memory by the demo). ~1,832 tests green.

### Slice 5 — Fleet / Aircraft detail pages (build-complete, awaiting merge)

**Added**

- **First-class fleet records.** Additive nullable columns on `resource` for aircraft —
  `make`, `model`, `year`, `serial_number`, `home_base_location_id` (same-org composite FK
  to `location`), and meter-config flags `has_hobbs` / `has_tach` (migration `0007`,
  human-gated). `resource_kind_shape_check` unchanged; existing inserts unaffected.
- **Per-aircraft detail aggregation.** New `fleet/` API: `getAircraftDetail` stitches a
  single aircraft's identity + current grounding status + open-squawk count & recent
  squawks + recent dispatch history + last-recorded Hobbs/tach (from the latest *closed*
  ticket) + upcoming reservations — all tenant-isolated in one org context.
  `listAircraft` (fleet list with status chips), `updateAircraft` (identity-only, audited),
  `listLocations`. New `fleet:access` / `fleet:manage` capabilities.
- **Fleet UI.** `/fleet` list (tail #, make/model, Grounded / open-squawk / status chips)
  and `/fleet/[id]` detail (identity, grounding banner, last-recorded meters, open squawks
  with deep-links, recent dispatch, upcoming reservations) + an Edit Aircraft dialog. New
  Fleet nav item.

**Notes**

- Read-only display of meters (labeled "last recorded", not an airframe/airworthiness total)
  — no computation, so it does not trip the dispatch correction-table predecessor. No
  inspection/AD/airworthiness logic (Phase 4 forward seam only). Migration `0007` staged +
  human-gated, applied in-memory by the demo. Reviewer APPROVE + compliance PASS. ~1,822 tests green.

### Slice 3b — Squawks + operator-set grounding (build-complete, awaiting merge)

**Added**

- **Aircraft grounding (operator data, not a reg determination).** New append-only,
  event-sourced `aircraft_grounding` table (`grounded`/`released` events with reason +
  audit; org-scoped, ENABLE+FORCE RLS). `groundAircraft` / `unGroundAircraft` (idempotent)
  / `getGroundingStatus`. Pure, property-tested `evaluateGroundingGate` makes grounding a
  third gate dimension: **warn-only at reservation create** (additive optional
  `groundingWarnings` on the success result; the FROZEN shared create path is byte-identical
  otherwise) and a **hard block at dispatch check-out** (`openDispatch` gains a `grounded`
  refusal arm — a grounded aircraft cannot be dispatched). Grounding status is surfaced on the
  board and in the new-reservation flow **before** booking.
- **Squawks (discrepancy reports).** New `squawk` table (open/deferred/resolved lifecycle,
  severity low/medium/high/grounding; write-once reported facts, status-forward only).
  `reportSquawk` / `updateSquawkStatus` / `listSquawks` / `getOpenSquawkCounts`. A
  `severity='grounding'` squawk NEVER auto-grounds — grounding is always an explicit operator
  act. Squawk-on-return capture at check-in. New `/maintenance/squawks` admin surface +
  open-squawk counts on the board.
- **RBAC.** New `maintenance:access` / `maintenance:ground` / `maintenance:squawk` capabilities
  (mechanic role gains its first surface; CFIs can squawk but not ground).

**Notes**

- Migration `0006` staged + human-gated, NEVER applied to a real DB (the zero-setup demo
  applies it in-memory). Compliance PASS (grounding/squawks are operator data, fully audited,
  no meter access, no computed Part-91/43 determination). 1,586 tests green.

## [Unreleased] — Phase 0 (Foundation)

### Slice 0.3 — Isolated empty app shell + server-side RBAC gating

**Added**

- **RBAC capability model (`@aeroops/core`).** Single-source `ROLE_CAPABILITIES`
  matrix maps 8 roles (owner, manager, dispatcher, cfi, mechanic, renter,
  student, accountant) to capabilities: all roles can `app:access` (gates entry
  to the app shell); owner + manager can `org:manage_settings` (edit org config,
  deferred to future slices). Pure `can(role, capability)` and
  `capabilitiesForRole(role)` helpers with fail-closed, prototype-chain-safe
  semantics (unknown role/capability → false/[], never throw). `isMembershipRole`
  guard validates the role at the session boundary to catch malformed/external
  roles (degrades to clean deny).
- **Server-side enforcement (`@aeroops/api`).** `requireCapability(session,
  capability)` is the canonical RBAC gate, called at the top of every protected
  data fetch and mutation. Throws `UnauthenticatedError` (no/incomplete session)
  or `ForbiddenError` (role lacks capability); returns the narrowed session on
  success. `hasCapability` and `filterNavForSession` are UX/nav predicates only
  and never the sole gate (hiding a nav item is cosmetic; direct-URL access is
  blocked server-side).
- **App shell (`apps/web`, `(shell)` route group).** Authenticated landing wraps
  the dashboard and settings pages. Header includes org name (tenant-scoped via
  `getSessionOrg(session)` + RLS), user email, and role badge (ROLE_LABELS,
  never raw enum). Desktop sidebar + mobile drawer nav show role-filtered items:
  Dashboard (all roles, `app:access`); Org settings (owner + manager only,
  `org:manage_settings`, nav item hidden for other roles). Layout calls
  `filterNavForSession()` (UI only) to build the nav; the actual gate is
  `requireCapability()` in the page handler.
- **Org settings page (`/o/[slug]/settings`).** Read-only display of org name,
  slug, and status. Server-side gate: `requireCapability(session,
  'org:manage_settings')` throws `ForbiddenError` for renter/student/dispatcher/
  cfi/mechanic/accountant roles; catch block converts error to a redirect via
  `mapAuthErrorToResponse()` (pure helper, unit-testable). Non-owner hitting the
  URL directly is redirected to `no-access?reason=insufficient_role`, not merely
  absent from nav. Future slices add form fields + mutations.
- **Dashboard page (`/o/[slug]` or `/o/[slug]/`).** Greeting by org name,
  status banner (org active, Hubs coming later), and non-interactive placeholder
  cards for Scheduling, Billing, Training Hub stubs (marked "Not yet available",
  reduced opacity). Displays `locationCount` from `getDashboardSummary(session)`
  — the first real, tenant-scoped data point visible, proving RLS + session
  identity work end-to-end. All queries scoped to `session.orgId` (JWT, RLS
  backstop).

**Phase 0 DoD (Definition of Done)**

- A logged-in user in an isolated org sees only their org's empty app with
  role-appropriate navigation and read-only Org settings page, gated
  server-side.

**Security & boundaries**

- `apps/web` imports only `@aeroops/core` + `@aeroops/api`; never `@aeroops/db`.
  All DB access funneled through `@aeroops/api` helpers.
- Every protected entrypoint calls `requireCapability(session, cap)` before any
  data fetch; `ForbiddenError`/`UnauthenticatedError` are converted to redirects
  (no JSON error responses in Phase 0).
- Role-capability matrix is compile-time-checked (TypeScript `satisfies`) for
  exhaustiveness; adding a new role to `MEMBERSHIP_ROLES` without updating the
  matrix produces a compile error.
- Session `orgId` and `role` are immutable per token lifetime (8 hours). RLS
  scopes every row by `orgId` regardless of RBAC, so a stale role can at worst
  over/under-grant within the user's own org, never cross-org.

**Tests**

- Capability matrix logic: role→capability lookup + prototype-key fail-closed +
  exhaustiveness.
- RBAC allow/deny per role (owner/manager + org:manage_settings).
- Dashboard tenant-isolation (org_id scoping, RLS + session identity).
- Nav filtering (filterNavForSession returns correct items per role).
- Auth error handling (mapAuthErrorToResponse pure, unit-testable).

**Deferred** (tracked for later slices)

- Instant role revocation (membership-epoch check / session-revocation list) —
  Slice 0.4+ (stale role is bounded by JWT lifetime; RLS prevents cross-org
  leak).
- Browser e2e tests + live-DB demo — Slice 0.4.
- Audit logging for nav/access attempts — Phase 2+.

### Slice 0.2 — Auth + session-bound org context

**Added**

- **Auth.js (NextAuth v5) with Credentials provider.** Email + password login,
  argon2id hashing, JWT session strategy (`maxAge: 8 hours`). Credentials
  validated at two layers: (1) input shape via zod; (2) cross-org access
  rejected by Postgres RLS (tenant-scoped `verifyCredential`). Password never
  stored in JWT, token, or session; argon2id hash never returned to callers or
  logged.
- **Session field projection.** JWT carries `{ userId, orgId, slug, role, email
  }` (set by `jwtCallback` on sign-in, same function reference used by both
  full auth config + edge config). Session callback projects these onto the
  `AppSession` shape (`@aeroops/api/auth/types.ts`) used by all server-side
  code.
- **Tenant resolution by URL slug.** Login is org-scoped (`/o/[slug]/login`).
  `resolveOrgBySlug` is the ONLY platform-admin-scoped read in the auth path
  (SELECT on org table before any session exists). Resolves org.id, then
  `verifyCredential` runs under `withOrgContext(orgId)` — so cross-org password
  attacks are rejected at the RLS layer, never reaching credential verification.
- **Middleware (`apps/web/middleware.ts`) gates `/o/[slug]/*`.** Fail-closed:
  missing session → redirect to login; slug mismatch (session.slug ≠ URL slug)
  → redirect to correct org's login. Sessions are decoded+verified at Edge
  Runtime (no DB query), using `auth-edge.ts` + `buildEdgeAuthConfig`
  (JWT+session callbacks only, zero db/argon2 imports, safe for Vercel Edge).
- **Anti-enumeration (auth path).** `verifyCredential` runs constant-time
  password verification (argon2id) on all failure paths: missing user, missing
  credential, wrong password, missing membership. Errors return null uniformly;
  no "user not found" vs "password wrong" leakage.
- **AUTH_SECRET validation.** `buildAuthConfig` (full) + `buildEdgeAuthConfig`
  (edge) throw at call time if `AUTH_SECRET` is unset. `apps/web/auth.ts`
  performs runtime assertion: reject the build-phase placeholder
  `build-time-placeholder-not-a-real-secret-replace-me` at runtime (outside
  `next build` phase), so production cannot boot with a known secret (JWT
  forgery risk). Placeholder allowed only during `next build`.
- **`withSessionOrgContext` (request→org context).** Framework-agnostic seam in
  `@aeroops/api/auth/session.ts`. Accepts `AppSession | null | undefined`;
  throws `UnauthenticatedError('UNAUTHENTICATED')` if missing/incomplete. Calls
  `withOrgContext(db, session.orgId, fn)` — so the org_id for every tenant
  query comes ONLY from the verified JWT, never client input, never URL params.
  Two calling forms: app code (no db argument, uses `getDb()`) + tests (explicit
  `withSessionOrgContextWithDb`).

**Schema**

- **`auth_credential` table** (`packages/db/migrations/0001_auth_credential.sql`).
  Tenant-scoped, one-per-user credential row. Composite FK
  `(user_id, org_id) → app_user(id, org_id)` structurally prevents cross-org
  rows. Indexes on `org_id`. RLS enabled + forced; no platform-admin policy
  branch (auth_credential always accessed under `withOrgContext`, never by the
  control plane).
- **Human-gated migration.** `0001_auth_credential.sql` + rollback
  (`0001_auth_credential.down.sql`); NOT auto-applied. Staged for manual review
  + human sign-off before run.

**UI (apps/web)**

- **Next.js App Router with Tailwind + hand-rolled shadcn-compatible
  components.** Login screen, authenticated landing (minimal: "signed in to
  {org} as {role}"), no-access/bounce (no membership, suspended org), sign-out.
  All routes gated by middleware; session checked by `auth()` helper in
  server-side code only.

**Security hardening**

- **Edge bundle safety.** `auth-edge.ts` imports from
  `@aeroops/api/src/auth/edge-callbacks.ts` directly (not via the `@aeroops/api`
  barrel) to avoid pulling native deps (argon2, pglite, drizzle) into the Edge
  bundle. `edge-callbacks.ts` has zero DB/argon2 imports — pure field-copy
  logic, verified at module load.
- **Boundary invariant.** `apps/web` NEVER imports `@aeroops/db`. All DB access
  goes through `@aeroops/api` (which obtains the prod client via `getDb()`
  internally, memoized).
- **No db/argon2 at module load.** `buildAuthConfig` and `buildEdgeAuthConfig`
  do not require a db argument; the prod client is obtained lazily via `getDb()`
  inside the authorize callback (first request only). Test code injects an
  explicit db (pglite) via `withSessionOrgContextWithDb`.

**Deferred** (tracked for later slices)

- Auth event auditing (login/logout/mfa/password-change), signed audit trail —
  Slice 0.4+.
- Auth rate-limiting + WAF config — ops/Slice 0.5 (flagged `[VERIFY]` with ops).
- Instant JWT revocation (logout → invalidate existing tokens) — Phase 2, when
  first-class session table is introduced.
- Browser e2e tests + live-DB demo — Slice 0.4.

### Slice 0.1 — Tenant data spine + RLS backstop

**Added**

- **Tenant data spine (`@aeroops/db`, Drizzle + Postgres).** Tables, all
  `org_id`-scoped: `org`, `location`, `app_user`, `membership`. RBAC roles are
  encoded as the `membership_role` enum (owner, manager, dispatcher, cfi, mechanic,
  renter, student, accountant), single-sourced from `@aeroops/core`. Control-plane
  tables (not tenant-scoped): `plan`, `subscription`. Reserved append-only
  `audit_log`.
- **Tenant isolation via Postgres RLS (the backstop).** `ENABLE` + `FORCE`
  row-level security on every tenant table; fail-closed policies keyed on the
  `app.current_org_id` session GUC
  (`NULLIF(current_setting(..., true), '')::uuid` → unset/empty yields zero rows,
  never a cross-org read). `org` self-keys on `id`; org creation is gated behind
  `app.platform_admin = 'on'`. `plan`/`subscription` carry no tenant RLS and the
  app role is SELECT-only on them.
- **`withOrgContext(db, orgId, fn)` choke-point.** The only sanctioned path to
  tenant tables — opens a transaction and sets the GUC transaction-LOCAL, so context
  cannot leak across pooled connections. `withPlatformAdminContext` is the
  control-plane equivalent.
- **Client factory.** `createProdClient` (postgres-js; reads `DATABASE_URL` from
  `.env`, throws if unset, and asserts the connecting role is non-superuser) vs
  `createTestClient` (`@electric-sql/pglite`, in-process Postgres for tests).
- **`@aeroops/core`.** Canonical `MEMBERSHIP_ROLES` tuple + role types/labels.

**Security (hardening from QA review)**

- `set_config` calls are parameterized (bound values, no `sql.raw` string
  interpolation) — closes a stacked-query injection surface on the postgres-js
  simple query protocol.
- `createProdClient` refuses a superuser connection (FORCE RLS only binds
  non-superusers).
- `audit_log` UPDATE/DELETE revoked from the app role in addition to the
  policy-absence (immutability enforced at two layers).
- Session-scope GUC primitives are no longer part of the public package surface;
  `withOrgContext` / `withPlatformAdminContext` are the public API.

**Tests**

- Tenant-isolation suite on `@electric-sql/pglite` (no Docker), including
  property-based isolation tests and injection regression tests. Tests `SET ROLE`
  to the non-superuser app role so RLS is actually exercised (superusers bypass it).

**Migration**

- One human-gated migration (`packages/db/migrations/0000_loud_prodigy.sql`) with a
  staged rollback (`0000_loud_prodigy.down.sql`). Not auto-applied; no database is
  provisioned yet.

**Deferred** (tracked for later slices)

- `audit_log` tamper-evidence (hash chain / WORM) — Phase 2/3, before the first real
  audit writer.
- Dedicated `control_plane_role` owning `plan`/`subscription` writes; real-Postgres
  CI smoke test — Slice 0.4.
- Auth.js + session→`org_id` binding, platform-admin caller gating — Slice 0.2.
