# Slice PB-LR — Public-booking launch-readiness — build spec

**The two PB1 launch predecessors, built to the extent feasible without external infra. Two sub-slices.** Adopted
defaults (maintainer-away): hard-DELETE purge, 365-day default window, fail-OPEN CAPTCHA. [VERIFY]s routed to compliance.

## PB-LR.A — Lead-data retention/purge ([VERIFY-PB1-COMP-1]) — FULLY buildable + verifiable now
**Config: reuse `dispatch_config`** (already the per-org settings row + RLS + absent-row-defaults). Migration **0017**
(human-gated, additive): ADD `booking_request_retention_days int NOT NULL DEFAULT 365` (CHECK 0–3650; 0 = retention OFF /
keep forever — NOT delete-all) + `booking_request_retention_includes_converted bool NOT NULL DEFAULT false`. Add 0017 to all
db+api test migration arrays. Absent-row defaults {365, false}.
**Execution model (the safety call): per-org, session-scoped, RLS-backed, audited admin action — NOT a cross-org platform-
admin DELETE, NOT an auto-cron.** RLS DELETE policy (`booking_request_delete USING org_id=current_org_id`, already in 0015)
is the structural backstop. API (cap `org:manage_settings`, owner/manager): `setBookingRetention(session,{retentionDays,
includesConverted})` (zod 0–3650; upsert dispatch_config; ONE audit row `booking_retention.config_changed` prev+new) +
`getBookingRetention(session)` (defaults when absent; read-only) + `purgeExpiredBookingRequests(session,{dryRun=true})`:
inside withSessionOrgContext, read config (default 365), if days=0 → no-op {retentionDisabled}; cutoff = `now() -
make_interval(days=>$days)` (DB clock); eligible = `created_at < cutoff AND status IN ('new','contacted','declined')` (+
'converted' iff includesConverted); **DRY-RUN default** = SELECT count, no delete, NO audit; APPLY = `DELETE ... RETURNING`
+ ONE audit row `booking_request.purged` {deletedCount, retentionDays, includesConverted, cutoffIso} — **counts ONLY, NEVER
requester PII** (the point is the PII is gone). Hard-DELETE (not anonymize). Devops script `packages/db/scripts/purge-booking-
requests.mjs` (mirror migrate.mjs: dry-run default, CONFIRM_APPLY=1; enumerate org ids [the one platform read] then purge
EACH under its own withOrgContext — NOT one cross-org DELETE; system-actor audit) + `db:purge:booking[:apply]` scripts. UI:
a "Booking request retention" card in org settings / the booking inbox header (gated org:manage_settings): show window, edit
(0–3650 + includes-converted toggle, inline validation), "Purge now" → confirm dialog showing the DRY-RUN count first
("permanently delete X, cannot be undone") → apply. States loading/populated/empty(days=0 warn)/edit/error/permission-denied.
**Tests:** migration up/down + CHECK; setter cap + upsert + audit + range; getter defaults; purge happy (delete + counts-only
audit, NO PII) + dry-run (no delete/audit) + **days=0 no-op (the footgun)** + boundary (strict `<`) + converted excluded-by-
default / included-when-flagged (reservation survives, link NULLs via 0016) + idempotency (2nd run deletes 0) + cap +
**T-ISO headline** (org A purge never touches org B under enforced RLS) + a **property test** (deleted set == exactly the
predicate, never another org's row). audit_log is append-only (no DELETE) — purge touches ONLY booking_request; status-change
audit rows (status+id, no PII) are retained — [VERIFY for compliance].

## PB-LR.B — CAPTCHA verification seam ([VERIFY-PB1-SEC-1]) — seam buildable now; limiter+keys = maintainer deploy step
**Honest split:** the in-app CAPTCHA-verify SEAM + honeypot + per-org soft guard are code (shipped/here); the edge rate-
limiter/WAF + the provider keys are deploy config (NOT code). `CaptchaVerifier { verify(token?, ip?): Promise<boolean> }` in
@aeroops/core or `packages/api/src/booking/captcha.ts`; `NoopCaptchaVerifier` (always true — the DEFAULT when unconfigured →
submit byte-identical to today) + a provider adapter (Turnstile/reCAPTCHA, reads `CAPTCHA_SECRET_KEY` from env; absent key →
factory returns Noop). `getCaptchaVerifier()` factory reads `CAPTCHA_PROVIDER`/`CAPTCHA_SECRET_KEY`. **Wire into
`_submitImpl(db, slug, raw, verifier=getCaptchaVerifier(), remoteIp?)` AFTER the honeypot, BEFORE org-resolve+tx** (ADR-0013
invariants unchanged — tx body still INSERT-only, verifier outside tx, no DB access): `bookingRequestSchema` gains optional
`captchaToken?` (additive); on `verify()===false` → return the SAME generic `{ok:true}` silent-drop (anti-enumeration, like
honeypot/rate-guard); on verifier THROW → **fail-OPEN** (catch→allow; provider outage must not kill lead capture; log server-
side no PII). Public form: render the widget only when `NEXT_PUBLIC_CAPTCHA_SITE_KEY` is set (else unchanged); pass the token.
**Tests:** no-op-when-unconfigured = byte-identical to PB1 (existing submit tests green) + valid-token inserts + invalid-token
no-insert/{ok:true} + verifier-throws fail-open inserts + captchaToken optional + hook-runs-before-any-DB-access (honeypot/
captcha → no resolveOrgBySlug/no tx) + factory Noop-when-unset/adapter-when-set (mock env). NO property test (boolean gate).
**Deploy checklist** (append to DEPLOY.md / new docs/launch/public-booking-launch.md): Vercel WAF rate-limit `/api/public/
booking/*`; set CAPTCHA_PROVIDER/CAPTCHA_SECRET_KEY/NEXT_PUBLIC_CAPTCHA_SITE_KEY; schedule the purge (cron/action calling
the script) or operators run manual purge; verify a bot burst is throttled.

## Compliance: [VERIFY-PB1-COMP-1] SATISFIED by A (configurable retention + audited hard-delete of stale lead PII, counts-
only audit) — compliance confirm: hard-delete-vs-anonymize, 365 default acceptable, status-change audit-row retention OK.
[VERIFY-PB1-SEC-1] PARTIAL by B (seam built; WAF+keys = deploy step) — confirm fail-OPEN posture (lead availability > strict
bot reject). NO money, NO FAA. Route to compliance-officer. Order: build A first (has the human-gated migration), then B.
