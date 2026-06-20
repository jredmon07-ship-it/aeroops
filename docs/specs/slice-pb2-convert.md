# Slice PB2 — Convert a booking-request into a reservation — build spec + ADR-0014

**Closes the public-booking loop: from the triage inbox, staff convert a `booking_request` → a real reservation by
picking a tail + confirming the time, routed through the FROZEN `gatedCreateOccurrence` (NO bespoke INSERT). NO money.
Sub-slice PB2.1 schema(0016)+convert API → PB2.2 inbox convert UI.**

## ADR-0014 — Convert is a composite ATOMIC command
Create the reservation through the single sanctioned write path AND, only on that success, mutate the request to
`converted` — BOTH in ONE tx. A gate refusal (or any failure) rolls back BOTH (throw-to-rollback, like reschedule
ADR-0006): the inbox can never point at a non-existent reservation, and a reservation can never exist with its source
request still new/contacted. `FOR UPDATE` on the request row serializes concurrent converts (exactly one reservation).

## PB2.1a — Schema (migration 0016, human-gated)
`booking_request`: ADD ONE nullable column `converted_reservation_id uuid` (NO .references — composite FK hand-written).
Composite FK `booking_request_converted_reservation_org_fk (converted_reservation_id, org_id) → reservation(id, org_id)
ON DELETE SET NULL (converted_reservation_id)` (column-list SET NULL — only the link nulls, org_id untouched; targets
reservation_id_org_id_unique → cross-org link structurally impossible). **Shape-check UNCHANGED** (handled_shape_check
still holds; do NOT add a converted⇒reservation_id-NOT-NULL CHECK — PB1 flag-only converted rows + the SET-NULL action
both legitimately leave it NULL; the converted-with-a-reservation invariant lives in the command layer). No new RLS/grant
(rides existing 0015 policies). No index. Migration 0016 + .down (ADD COLUMN → ADD composite FK; down drops FK then
column). HUMAN-GATED banner, prereq 0000–0015, strictly additive. Add 0016 to ALL db + api test MIGRATION_SQL arrays.
Schema tests: column+FK exist; the composite FK rejects a cross-org (reservation_id, org_id) pair; ON DELETE SET NULL
nulls only the link; handled_shape_check still passes for a converted row with a null link; down reverses.

## PB2.1b — convert API (packages/api/src/booking/convert-booking-request.ts)
`convertBookingRequest(session, input)` + `convertBookingRequestWithDb(db, session, input, opts?{now})`. Input (zod):
`{ id:uuid (the request), resourceId:uuid (the tail — SINGLE resource in PB2), startAt:Date, endAt:Date }` (notes are
DERIVED, not input). **Authz BOTH, in order:** `requireCapability(session,'booking:triage')` then
`requireCapability(session,'schedule:create_reservation')` (converting reads triage AND creates a reservation →
owner/manager/dispatcher qualify — cfi has schedule:create_reservation but NOT booking:triage, so cfi is correctly
refused; front-desk triage is intentionally the gate). **Algorithm (ONE withSessionOrgContextWithDb tx):** (1) authz before any data;
(2) zod-validate (bad uuid → ValidationError); (3) load the request row `SELECT id,status,requester_name,requester_email,
requester_phone ... WHERE id=$id` (RLS-scoped; not visible → `{ok:false,reason:'not_found'}`) **FOR UPDATE**; (4)
idempotency guard: if status NOT in (new, contacted) → `{ok:false,reason:'not_convertible'}` (covers already-converted/
declined; allows converting straight from `new`); (5) create via the FROZEN path ON THE SAME tx —
`gatedCreateOccurrence(tx, sess, db, { startAt, endAt, resourceIds:[resourceId], notes:<derived>, auditMetadata:{source:
'booking_request', bookingRequestId:id} }, now)` (reuse the create-reservation.ts pattern; **NO bespoke INSERT**). If the
gate result is ok:false → **throw a sentinel `ConvertRefusedError` carrying the refusal** to force rollback; catch at the
top of the impl (outside tx) → return the carried refusal arm verbatim (the 5 frozen refusal arms: conflict / policy /
conflict_and_policy / twilight / availability — reuse CreateReservationResult types). `OccurrenceRaceError` (23P01) →
propagate → reProbeInFreshTx → `{ok:false,reason:'conflict',conflicts}` (request untouched). (6) on ok:true → UPDATE the
SAME row: status='converted', converted_reservation_id=<new id>, handled_by=sess.userId, handled_at=now(), updated_at=
now() (requester fields untouched); (7) ONE audit row `booking_request.converted` (metadata {previousStatus, reservationId,
resourceId} — NO requester PII beyond ids, NO money); (8) commit → `{ok:true,id,status:'converted',reservationId,reservation,
groundingWarnings?,twilightWarnings?,availabilityWarnings?}`. **Derived notes:** `"Public booking request — {name} {email}[
/ {phone}]"` (DO NOT create an app_user/member, DO NOT set a pilot; created_by=staff via the gated path; no dispatch).
**`updateBookingRequestStatus` change:** REMOVE `contacted→converted` from ALLOWED_TRANSITIONS (the ONLY path to converted
is now convertBookingRequest — kills the "converted but no reservation" footgun); keep new→contacted|declined, contacted→
declined|contacted, terminals terminal; update docblock. **`listBookingRequests`:** project `convertedReservationId` (read-
only additive) for the Converted-tab "View reservation" link. Barrel-export the command + result type.
Tests (HEADLINE): routes through gatedCreateOccurrence (grep — no bespoke reservation INSERT) + reservation has
created_by=staff + metadata.bookingRequestId; **atomic refusal per gate** (conflict/policy/conflict_and_policy/twilight-
block/availability-block → matching arm + NO reservation written + request STILL new/contacted, link NULL); atomic success
(reservation + request converted + link set, consistent); **double-convert concurrency** (two parallel → exactly one
reservation, loser not_convertible — FOR UPDATE); re-convert/declined guard → not_convertible; T-ISO (org A converts org
B id → not_found; org B resourceId → ValidationError, no write); caps (both required — owner/manager/dispatcher yes, cfi refused (no booking:triage);
missing either → Forbidden; unauth → Unauthenticated); ONE convert audit row, zero on refusal, no PII; converted_reservation_id
correct (set on success, NULL on refusal) + composite FK cross-org reject; updateBookingRequestStatus contacted→converted
now invalid_transition (regression); NO money (balance seam OFF no-op); warn-mode passthrough (grounding/twilight/availability
warn → ok:true + warnings, still converted); notes derivation (no app_user created); migration 0016 up/down.

## PB2.2 — Inbox convert UI (apps/web/.../booking/)
Convert dialog (`convert-dialog.tsx`) on new+contacted rows (renders only with BOTH caps; replaces the flag-only "Mark
converted"): read-only requester context block + a **tail picker** (reuse `listAircraft`/fleet:access, active aircraft —
NO new endpoint) + start/end datetime prefilled from requestedStart/End (null end → startAt+1h). Submit →
`convertBookingRequestAction` (await auth, parse ISO→Date at the action clock boundary, map Forbidden/Unauth/Validation,
serialize the returned reservation Dates→ISO, revalidate on success). States: form / submitting / success (dialog closes,
row → Converted, link to the schedule day of the new reservation, counts refresh) / refusal (INLINE, dialog stays open,
per-reason copy — conflict "tail already booked {windows}" / policy "{violations}" / twilight "crosses civil dusk — operator
blocks night ops (NOT an FAA §61.57 determination)" / availability "outside operating hours"; each says "No reservation was
created") / not_found (remove row) / not_convertible (refresh status) / forbidden-or-server (generic). Converted tab rows
show a "View reservation" link from convertedReservationId. NO new preview endpoint (authoritative refusal on submit suffices).

## Compliance [VERIFY-PB2-COMP-1]: NO money/Stripe/price (balance seam OFF no-op); the created reservation is an ordinary
operator booking — no airworthiness/dispatch/FAA determination by converting (no pilot, no ticket); twilight/availability
refusal copy keeps the verbatim disclaimers; requester PII unchanged (volunteered name/email/phone copied into the operator-
internal reservation notes + ids-only in audit) — folds into the PB1 retention posture. Route to compliance-officer.
