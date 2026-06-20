# Slice PB1 — Public booking-request page (unauthenticated, conservative) — build spec + ADR-0013

**THE-BIBLE public booking, scoped THIN: a public lead-capture booking-REQUEST (NOT instant-book, NO money, NO
reservation created, NO account creation, NO fleet/schedule exposure). Migration 0015 human-gated. Sub-slice
PB1.1 schema+secure-submit → PB1.2 staff triage → PB1.3 public page.**

## ADR-0013 — Unauthenticated booking-request write model (the crux)
There is NO session on the public page, so the session→RLS chain doesn't apply. **DECISION (Option A, airtight):**
the anon submit (a) resolves org by slug via the EXISTING `resolveOrgBySlug` (+ status==='active' gate — the only
sanctioned anon read), (b) derives `org_id` SOLELY from the resolved row (NEVER from client input — the wire body
has NO org_id/slug), (c) runs the INSERT inside the NORMAL `withOrgContext(db, resolvedOrg.id, ...)` choke-point so
the RLS `booking_request_insert WITH CHECK (org_id = current_org_id)` is the backstop — NOT `withPlatformAdminContext`
(which would BYPASS RLS). Defense in depth: the resolved org_id is BOTH the GUC AND the row's org_id; RLS enforces
they match — a bug can't smuggle a different org_id. The orchestrator's tx body is EXACTLY ONE statement (the
booking_request INSERT) — no SELECT/JOIN/second write of any tenant table (the only tenant read anywhere is
resolveOrgBySlug's fixed {id,name,slug,status} projection). The mobile-login route is the exact anon-POST precedent.
**INVARIANT (reviewer must reject any violation):** the anon tx body is INSERT-only + org_id bound ONLY from
resolveOrgBySlug. **Anti-abuse (no CAPTCHA in PB1):** honeypot `website` field (non-empty → fake success, no insert);
zod bounds (name 1–120, email format ≤254, phone ≤40, message ≤2000, aircraftTypePref ≤80 free-text, requestedStart
required ISO in [now-1h, now+365d], requestedEnd>start) mirrored by DB CHECKs; a per-org DB soft rate-guard
(count booking_request in last 1 min for the org; over a constant e.g. 10 → silent drop returning fake success — no
bot signal; per-IP in-memory is theater on serverless, omitted). **[VERIFY-PB1-SEC-1] (HARD LAUNCH PREDECESSOR, not a
build blocker):** edge rate-limiter/WAF + CAPTCHA before public exposure (same posture as verify-credential + 4M-SEC-2).
**No data leak:** the public page/endpoint read ONLY the org name via resolveOrgBySlug; aircraftTypePref is FREE-TEXT
(no fleet list shown); thank-you echoes only what the requester typed (no id). Reversible/additive; no money;
nothing irreversible.

## PB1.1 — Schema (migration 0015) + secure submit (the load-bearing slice; full security + adversarial review)
**Table `booking_request`** (`packages/db/src/schema/booking-request.ts`, mirror member-tag/squawk byte-pattern):
id uuid PK; org_id NOT NULL (FK→org CASCADE); status text DEFAULT 'new' (CHECK in new/contacted/converted/declined);
write-once requester fields: requester_name (nonempty CHECK), requester_email (nonempty CHECK; format in app),
requester_phone?, requested_start timestamptz NOT NULL, requested_end? (CHECK end>start), aircraft_type_pref? (free
text), message?; triage fields (staff-mutable): handled_by? (composite FK `(handled_by,org_id)→app_user SET NULL` —
durable who in audit_log), handled_at?, triage_notes?; created_at/updated_at. `booking_request_handled_shape_check`
(status='new' ⇒ handled_by/handled_at NULL; contacted/converted/declined ⇒ handled_at NOT NULL; handled_by NOT in the
NOT-NULL arm — SET NULL). UNIQUE(id,org_id); index (org_id,status,created_at DESC) (covers inbox + rate-count). NO
requester FK (anon by design); NO reservation FK (manual conversion in PB1; future converted_reservation_id). ENABLE+
FORCE RLS + 4 fail-closed policies + grant. Migration 0015 + .down human-gated; add 0015 to all db test arrays.
**`bookingRequestSchema`** (zod, in `@aeroops/core`, shared by the form + the submit) per the bounds above + honeypot.
**`submitBookingRequest(db, slug, input)` + `*WithDb`** (`packages/api/src/booking/`): honeypot→fake ok; zod validate→
generic invalid (no enumeration); resolveOrgBySlug + active gate → null/suspended → generic `unavailable` (no enum,
no write); else `withOrgContext(db, resolvedOrg.id, tx => { rate-guard; INSERT one row org_id=resolvedOrg.id status=new
RETURNING id })`; return `{ok:true}` (NO id/tenant data). **Public route** `apps/web/app/api/public/booking/[slug]/route.ts`
(Node runtime, NO SQL, NO @aeroops/db, delegates to submitBookingRequest; malformed→generic). **Middleware**
`apps/web/middleware.ts`: add an explicit `if (pathname==='/book'||pathname.startsWith('/book/')) return next()` +
allow `/api/public/booking/*` (both already not under /o/ so reachable; make explicit + comment ADR-0013) — `/o/[slug]/*`
protection UNCHANGED.
**Security tests (the headline):** insert's org_id == slug-resolved org for many slugs; a client-supplied org_id/slug
in the body is IGNORED (row tracks the slug); cross-org write rejected by WITH CHECK (adversarial); the public path
issues ONLY resolveOrgBySlug's SELECT + the one INSERT (no tenant read — spy/log); unknown vs suspended → byte-identical
generic result (no enumeration); honeypot→no insert; oversized/invalid→rejected (schema+CHECK); rate-guard drops the
N+1th; migration 0015 up/down + RLS fail-closed.

## PB1.2 — Staff triage (session-scoped, normal RLS)
NEW cap `booking:triage` (owner/manager/dispatcher) in capabilities.ts (alphabetical + matrix note + exhaustiveness
test). `listBookingRequests(session,opts?)` (requireCapability booking:triage FIRST; withSessionOrgContext; default
status='new' newest-first; status filter + counts) + `updateBookingRequestStatus(session,{id,status,triageNotes?})`
(transitions new→contacted|declined, contacted→converted|declined|contacted; sets handled_by=session.userId+handled_at;
ONE audit row; **converted creates NO reservation** in PB1). Staff inbox UI `/o/[slug]/(shell)/booking/page.tsx` +
nav "Booking requests" (booking:triage). Tests: cap enforcement, T-ISO (org A never sees B), transitions +
shape-check, audit per change, converted→no reservation.

## PB1.3 — Public page UI (`apps/web/app/book/[slug]/page.tsx`, NOT the app shell)
Resolve org → unknown/suspended → ONE neutral "This operator isn't accepting online requests right now." card
(merged, no enumeration); active → the request form (name/email/phone?/date+optional-end/aircraftTypePref free-text/
message + hidden honeypot `website` + the "This is a request — the operator will contact you to confirm. Not an instant
booking." disclaimer) POSTing to /api/public/booking/[slug]. Thank-you state (echo only typed fields + org name);
invalid→inline generic; unavailable→the neutral card. Minimal chrome, NO nav, NO tenant data, brand = org name only.

## Compliance: NO money/Stripe/payment (lead-capture only); NO reservation/airworthiness/dispatch consequence; NO FAA
determination (aircraftTypePref = free-text requester input); PII = minimum lead data the requester volunteers
([VERIFY-PB1-COMP-1] low: confirm lead-data storage + a retention/purge posture before launch); status changes audited;
requester fields write-once. Route to compliance-officer.
