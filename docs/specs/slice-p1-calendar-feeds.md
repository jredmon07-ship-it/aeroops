# Slice P1.4 — iCal / subscribable calendar feeds

Status: BUILD-COMPLETE (awaiting human review/merge). Branch `slice/code-health-rows-helper`.
Migration `0028_calendar_feed.sql` STAGED, human-gated, NOT applied. No reviewer/compliance
sub-agent pass per the standing P1 session rule (`docs/ROADMAP.md`) — maintainer
reviews the diff personally.

## Scope (in this slice)

Read-only, auto-refreshing `.ics` subscription feeds a member or staffer can add to Apple
Calendar / Google Calendar / Outlook:

- **`my_reservations`** — the caller's OWN reservations (booker `created_by` OR a non-voided
  dispatched pilot), self-scoped. Any authenticated user can get one (gated on `app:access`,
  the broadest capability — every role has it — because the read is hardwired to the caller's
  own `session.userId`, same self-scope posture as the portal's other self-service reads).
- **`aircraft`** — one aircraft's reservations. Gated on `fleet:access` (the same capability
  that already gates the Fleet detail page this is created from).

Both scopes read a **rolling `[now-7d, now+90d)` window** — recent history + the near future.
No caller-configurable window (the public route takes no query string at all).

Competitive parity: Flight Schedule Pro advertises "Google Calendar Sync, iCal/iOS/Android" —
see `docs/ROADMAP.md` P1 item 4.

## The auth model: a capability URL, not a session

A calendar app's periodic background `GET` cannot do session auth (no cookie jar, no login
flow). The standard iCal pattern — used by Google Calendar's and Outlook's own "secret
address" feeds — is a **long, cryptographically-random, unguessable per-feed token in the
URL**. AeroOps already has exactly this shape for the mobile bearer token (ADR-0010); this
slice reuses the same posture:

- `generateFeedToken()` (`packages/api/src/calendar/internal.ts`) — `node:crypto randomBytes(32)`
  → `base64url` (~256 bits of entropy, 43 characters).
- Stored **as-is** in `calendar_feed.feed_token` (a bearer capability, not a password — no
  hashing, matching the mobile-token precedent; the token itself carries no meaning beyond
  "possession = read access to this one feed").
- The public route `GET /api/calendar/[token]` takes the token **only** from the URL path
  segment. There is no session, no query string, no request body on this route.
- **Anti-enumeration**: an unknown token and a revoked (`active=false`) token return the
  **exact same generic 404** — `resolveFeedByToken` collapses both cases to `null` before the
  route ever sees a difference.

## Architecture

### The pre-context lookup (`packages/api/src/calendar/resolve-feed.ts`)

`resolveFeedByToken(db, token)` is the **one** sanctioned `withPlatformAdminContext` read in
this path — it mirrors `resolveOrgBySlug` (the login-path org lookup) and
`resolveOrgByStripePaymentIntentId` (the Stripe webhook path) **exactly**: read-only, a fixed
projection (`{id, orgId, userId, scope, resourceId}`), keyed by an exact match on a globally
unique column (`feed_token`), called from exactly one unauthenticated entry point. Every
subsequent read/write uses the `orgId` **this function resolved from our own table** — never
platform-admin context, never anything client-suppliable.

`calendar_feed_select`'s RLS policy additionally admits `platform_admin='on'` (migration 0028)
— the same one-line policy shape as `payment_intent_record_select` / `stripe_customer_select`.
Every WRITE policy (`INSERT`/`UPDATE`/`DELETE`) stays plain org-GUC-only.

### The read (`packages/api/src/calendar/build-ics-for-feed.ts` + `internal.ts`)

`buildIcsForFeed(db, feed, now?)` opens `withOrgContext(db, feed.orgId, ...)` and calls one of:

- `readCalendarEventsForUser(tx, userId, from, to)` — mirrors `portal/internal.ts`'s
  `readMyReservations` predicate (`created_by = me OR a non-voided dispatched pilot`)
  **exactly**, minus its future-only / `LIMIT 20` restriction (a calendar feed serves a bounded
  rolling window, not "next 20 upcoming").
- `readCalendarEventsForResource(tx, resourceId, from, to)` — one tail's reservations in-window.

Then a **best-effort** `last_accessed_at` bump runs in its own separate `withOrgContext` call
(never inside the same transaction as the read) so a bump failure can never roll back — or be
rolled back by — the calendar response a calendar app is waiting on.

### The pure serializer (`packages/core/src/calendar/build-ics.ts`)

`buildIcs(events, opts?)` — the **security-sensitive core**, tested hard (property tests, see
below). RFC-5545 `VCALENDAR`/`VEVENT`, `CRLF` line terminators, UTC `DTSTART`/`DTEND`
(`yyyymmddThhmmssZ`), full `TEXT` escaping (`\`, `;`, `,`, newlines) per §3.3.11, and line
folding at 75 octets per §3.1 (UTF-8-code-point-aware — never splits a multi-byte character).
Pure: no `Date.now()` — `now` is injected (mirrors the recurrence expander's injected tz
resolver convention) so output is deterministic and testable.

**Why escaping matters here specifically**: reservation `notes` are free-text member/staff
input. Without full escaping, a note containing a raw newline or comma could inject a bogus
extra `VEVENT`/property line into the `.ics` document a calendar app parses. Every `TEXT`
field goes through `escapeIcsText` before it ever reaches the output string — see
`packages/core/src/calendar/__tests__/build-ics.test.ts` for the adversarial property coverage
(injection safety, round-trip, no-unescaped-delimiter, determinism, UTF-8-safe folding).

### The web route (`apps/web/app/api/calendar/[token]/route.ts`)

Thin transport adapter — no SQL, no `@aeroops/db` import, no business logic: `resolveFeedByToken`
→ generic 404 on `null` → `buildIcsForFeed` → `text/calendar; charset=utf-8` with a
`Content-Disposition: inline; filename="aeroops.ics"` header. `/api/calendar/*` is not under
`/o/[slug]/*` so it already passes the session middleware's matcher; documented explicitly in
`apps/web/middleware.ts` (same pattern as `/api/public/*` and `/api/mobile/*`).

### Commands (`packages/api/src/calendar/`)

| Command | Cap gate | Notes |
|---|---|---|
| `createCalendarFeed` | `app:access` (`my_reservations`) / `fleet:access` (`aircraft`) | One feed per `(user, scope[, resource])` — returns the existing **active** feed instead of minting a duplicate (look-then-insert; no DB-level natural-key `UNIQUE`, documented as a low-severity race in the file header). Audited `calendar.feed_created`. |
| `listMyCalendarFeeds` | `app:access` | Self-scoped to `session.userId` — a member's own feeds only (both scopes). |
| `revokeCalendarFeed` | `app:access` | Self-owned lookup (`id` + `org_id` + `user_id` must all match) — a member can never revoke another member's feed, even in the same org. Sets `active=false`; row stays for audit history. Audited `calendar.feed_revoked`. |
| `regenerateCalendarFeed` | `app:access` | Atomic revoke-old + create-new (same scope/resource, a fresh token) in **one** tx. Audited both `calendar.feed_revoked` and `calendar.feed_created` (`metadata.reason='regenerate'`). |

## Schema (migration `0028_calendar_feed.sql`, STAGED — NOT applied)

`calendar_feed(id, org_id, user_id, scope, resource_id, feed_token, active, last_accessed_at,
created_at, updated_at)`:

- `calendar_feed_scope_check`: `scope IN ('my_reservations','aircraft')`.
- `calendar_feed_scope_shape_check` — **the structural guarantee**: `resource_id IS NOT NULL`
  iff `scope='aircraft'`. A row can never be ambiguous about what it feeds.
- `UNIQUE (feed_token)` — the URL secret + the lookup key (also serves as the index — no
  separate plain index needed, mirrors `stripe_payment_method_stripe_id_unique`).
- Composite FK `(user_id, org_id) → app_user ON DELETE RESTRICT` — an owner can't be deleted
  out from under an active subscription without an explicit revoke first.
- Composite FK `(resource_id, org_id) → resource ON DELETE RESTRICT` — nullable.
- `ENABLE + FORCE RLS`, standard 4-policy **plus** the platform-admin `SELECT` branch above.

## Tests

- `packages/core/src/calendar/__tests__/build-ics.test.ts` — the pure-serializer property
  suite: round-trip (uid/start/end/summary/description survive `build → unfold → unescape`
  exactly, modulo RFC-5545's single newline-escape normalization), no-unescaped-delimiter,
  injection safety (adversarial `BEGIN:VEVENT`/`END:VCALENDAR` text in a summary can never
  forge extra blocks), determinism, and UTF-8-safe line folding.
- `packages/api/src/__tests__/calendar-api.test.ts` — integration tests against PGlite:
  `createCalendarFeed` uniqueness + self-scope + per-scope capability gating;
  `resolveFeedByToken` crosses the pre-context boundary correctly and returns `null` for an
  unknown **and** a revoked token; `buildIcsForFeed('my_reservations')` leaks **nothing** across
  members (T-ISO adversarial: another member's booked/piloted reservation never appears) or
  orgs; `buildIcsForFeed('aircraft')` returns exactly that tail's in-window events; a revoked
  feed's token resolves to `null` end-to-end.

## Deferred (out of scope for this slice)

- **Two-way sync / CalDAV write-back.** This is a one-way, read-only mirror. Creating/editing a
  reservation from within a calendar app is not supported (and is a much larger surface — CalDAV
  auth, conflict-detection re-entry through the gated create path, etc.).
- **Per-event alarms/reminders.** RFC-5545 `VALARM` blocks are not emitted — reminder timing is
  a calendar-app/client-side setting today, not an AeroOps-configured one.
- **Org-wide feeds** (the whole schedule board as one feed for e.g. a front-desk display). Only
  self-scoped and per-aircraft feeds exist in this slice.
- **Instructor feeds** (an instructor's own teaching schedule, distinct from their own
  booker/pilot reservations). Would need its own read predicate (`instructor_user_id` on the
  resource, or a dispatch/lesson-record join) — not built here.

## Compliance / money boundary

No money, no FAA/Part-91/etc. determination — a read-only calendar mirror of existing
scheduling data the caller could already see through the app. `notes` text is rendered
verbatim (escaped) into `DESCRIPTION` — the same free-text-only posture as every other surface
that displays a reservation note.
