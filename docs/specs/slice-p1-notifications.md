> Note 2026-10-10: money features were removed from AeroOps; the invoice, payment, and dues notification types described here no longer exist.

# Slice P1.3 — Email notifications

Status: BUILD-COMPLETE (awaiting human review/merge). Branch `slice/code-health-rows-helper`.
Migration `0026_notifications.sql` STAGED, human-gated, NOT applied. No reviewer/compliance
sub-agent pass per the standing P1 session rule (`docs/ROADMAP.md`) — founder
reviews the diff personally.

## Scope (in this slice)

Best-effort, transactional email for six operational events:

| event_type            | recipient (this slice's simplification) | template summary                         |
|------------------------|------------------------------------------|-------------------------------------------|
| `reservation.created`  | the member who booked (`session.userId`) | "Your reservation is confirmed."          |
| `squawk.reported`      | the reporter (`session.userId`)          | "A squawk was recorded."                  |
| `aircraft.grounded`    | the staff member who grounded it (`session.userId`) | "An aircraft was grounded."   |
| `invoice.finalized`    | `invoice.memberUserId`                   | "Your invoice is ready."                  |
| `payment.failed`       | `invoice.memberUserId`                   | "A payment on your account did not go through." |
| `dues.generated`       | `dues_schedule.userId` (per created invoice) | "Your dues invoice is ready."         |

Channel: email only. Provider: [Resend](https://resend.com) (`POST https://api.resend.com/emails`,
confirmed live against `resend.com/docs/api-reference/emails/send-email` 2026-07 — see
`packages/api/src/notifications/email-provider.ts` header). No SMS/push in this slice.

## Recipient-simplification note (read before broadening)

For `squawk.reported` and `aircraft.grounded` the spec's "keep simple: the reservation/squawk
owner" instruction is implemented as a **self-notification to the acting staff member**
(reporter / grounder) — a "your action was recorded" receipt — rather than a broader
operator notify-list (owner/manager/dispatch). Building a real notify-list requires either an
operator-configurable recipient set or a role-based broadcast, both deferred (see below). This
keeps the hook wiring trivially simple (no extra DB reads at the web-action layer) and gives a
concrete, testable, real recipient today. **Follow-up**: replace with an operator-configurable
"who gets ops alerts" list before this is relied on for real fleet-safety communication.

## Architecture

### The seam (`packages/api/src/notifications/email-provider.ts`)

Mirrors `booking/captcha.ts` and `integrations/stripe/client.ts` exactly:

- `EmailProvider` interface — `send({to, subject, html, text}): Promise<{id}>`.
- `StubEmailProvider` — the **default** when `EMAIL_API_KEY` or `EMAIL_FROM` is unset. Logs a
  single "would send" line (recipient + subject only, never the body) and returns a synthetic
  id. **Never throws** — so `sendNotification`'s caller-visible behavior (a `notification_log`
  row with `status='sent'`) is identical whether or not email is configured, exactly like
  `NoopCaptchaVerifier`'s "byte-identical when unconfigured" posture.
- `RealEmailProvider` — raw `fetch` against Resend's REST API. No npm SDK (house
  no-new-heavy-deps posture).
- `getEmailProvider()` — memoized factory; `__resetEmailProviderForTests()` for tests.

### Templates (`packages/api/src/notifications/templates.ts` + `email-event-types.ts`)

Pure functions, one per `event_type`, each returning `{subject, html, text}`. Money is
rendered from **integer cents** (`formatCents`) — never a float. Copy is plain and
operator-operational: **no FAA/airworthiness/currency/Part-61/141/91/43 determination
language, no money/collections advice** (compliance-load-bearing; see the templates file
header).

`email-event-types.ts` is named that way — not `types.ts` — because `notifications/types.ts`
already exists as the **pre-existing, unrelated** Slice N1 in-app-alerts-bell result-type
module (`AlertKind` / `MyAlert` / `MyAlertsResult`, `get-my-alerts.ts` / `internal.ts`). Do
not rename/move either file without checking both consumers.

### The dispatcher (`packages/api/src/notifications/send-notification.ts`)

`sendNotification(session, { toUserId, eventType, templateData })` — THE function every hook
calls. **Never throws** (wraps its whole body in try/catch, mirrors
`demo/reset.ts`'s `maybeResetDemoTenant`):

1. Resolve the recipient (`app_user` row for `toUserId`, RLS-scoped to `session.orgId`). Not
   found → no log row, return `{sent:false, reason:'recipient_not_found'}`.
2. Resolve the pref (`notification_pref` WHERE org/user/event_type). No row → enabled
   (default opt-IN). Disabled → **one** `notification_log` row `status='skipped'`, provider
   never called.
3. Render the template (pure).
4. Call the provider. Success → `status='sent'`. Provider throw → `status='failed'` +
   `error_detail` (the provider error's message ONLY — never the email body).

Runs in its **own fresh** `withSessionOrgContext(WithDb)` scope, called from the web action
layer **after** the triggering command's own transaction has already committed — mirrors
`triggerAutopayOnFinalize`'s "external I/O never inside the core tx" posture.

### Preferences (`packages/api/src/notifications/prefs.ts`)

`getMyNotificationPrefs` / `setMyNotificationPref` — self-scoped (no `userId` param, always
`session.userId`), gated on **`app:access`** (every role holds it — notification prefs are
personal, not role-scoped). Absence of a `notification_pref` row means enabled; the UI always
gets the full `NOTIFICATION_EVENT_TYPES` list with a resolved boolean per entry.

## Hook points — command-layer vs web-action-layer, and why

**All six hooks are wired at the WEB ACTION LAYER** (`apps/web/app/o/[slug]/(shell)/*/actions.ts`),
never inside a `packages/api` command's own transaction:

- `createReservationAction` (`schedule/actions.ts`) → `reservation.created`. `createReservation`
  wraps the **FROZEN** `gatedCreateOccurrence` (ADR-0004/0006) — the task instructions
  explicitly require preferring the web-action-layer hook when the core command is frozen.
  Verified: `git diff HEAD -- packages/api/src/scheduling/internal.ts` is empty.
- `reportSquawkAction` / `groundAircraftAction` (`maintenance/actions.ts`) → `squawk.reported`
  / `aircraft.grounded`. Not strictly frozen, but kept at the same layer for consistency and to
  avoid touching maintenance command internals at all.
- `finalizeInvoiceAction` (`billing/actions.ts`) → `invoice.finalized` always;
  `payment.failed` when `result.autopay?.outcome === 'declined'`.
- `runDuesForPeriodAction` (`billing/actions.ts`) → `dues.generated`, once per newly-created
  invoice in `result.created`.

Every call site follows the same shape:

```ts
const result = await coreCommand(session, input);
if (result.ok && session) {
  await sendNotification(session, { toUserId, eventType, templateData }).catch(() => {});
}
return result;
```

`sendNotification` itself never throws; the `.catch(() => {})` is defense-in-depth only (see
`notifications.test.ts` §7 for a test that proves a throwing provider does not affect the
core command's result).

### `payment.failed` — no async webhook "failed" event exists

The task description frames this as "from the Stripe webhook's failed branch." In this
codebase, `handle-webhook-event.ts` only ever acts on `payment_intent.succeeded` /
`setup_intent.succeeded` — there is **no** async "payment failed" webhook event handled
anywhere. The actual failure signal is the **synchronous** off-session decline
(`StripeCardDeclinedError`, HTTP 402) inside `triggerAutopayOnFinalize`, surfaced back through
`finalizeInvoice`'s `autopay.outcome === 'declined'`. This is the functionally-equivalent hook
point and is what this slice wires. Documented here as a deliberate deviation from the literal
task wording, not an oversight.

### Additive result-type changes (non-frozen, low-risk)

- `GenerateDuesInvoicesCreated` (billing/generate-dues-invoices.ts) gained `userId` +
  `amountCents` fields so the web action layer (which never imports `@aeroops/db`) can build
  the `dues.generated` notification without its own DB read. Purely additive; no existing test
  asserts the exact shape of `result.created` entries (checked).

## Schema (migration `0026_notifications.sql`, STAGED — NOT applied)

- **`notification_log`** — APPEND-ONLY (SELECT+INSERT RLS only, like `ledger_entry`/`dues_run`/
  `audit_log`/`stripe_event`). Columns: `id, org_id, user_id (nullable, simple FK → app_user.id
  ON DELETE SET NULL — mirrors audit_log.actor_user_id), channel (CHECK 'email'), event_type
  (free text), to_email, subject, status (CHECK sent|failed|skipped), error_detail, created_at`.
  **Never stores the rendered email body** — only the recipient address + subject line survive.
- **`notification_pref`** — standard 4-policy mutable RLS (mirrors `dues_schedule`). Columns:
  `id, org_id, user_id (composite FK → app_user(id,org_id) ON DELETE CASCADE), event_type,
  email_enabled (default true), created_at, updated_at`. `UNIQUE(org_id, user_id, event_type)`
  is the upsert target.

Both tables: `org_id NOT NULL` + `ENABLE + FORCE ROW LEVEL SECURITY` + the standard
`current_org_id` GUC predicate. See the migration file header for the full FK/CHECK rationale,
including why `notification_log.user_id` deliberately uses a **simple** (non-composite) FK
(avoids the composite-FK-`ON DELETE SET NULL`-needs-column-list-syntax footgun noted against
`dispatch_ticket.closed_by` in migration `0005`).

## UI

- `/o/[slug]/notifications` — self-service toggle list (`NotificationPrefsCard`), one row per
  event type, independent optimistic save per row. Gated on `app:access` (every role) —
  intentionally **not** restricted like the portal (`portal:access`) or org settings
  (`org:manage_settings`) pages, since prefs are personal regardless of role.
- **Not added to the primary sidebar `NAV_ITEMS`** — every existing role's exact nav-item-count
  is asserted in `apps/web/lib/__tests__/nav.test.ts`, and `app:access` is universal, so adding
  a `NAV_ITEMS` entry would require revising every one of those assertions. Out of scope for
  this slice's footprint. Instead, reachable via a small always-visible "Notifications" text
  link in the app-shell header, next to the alerts bell (`(shell)/layout.tsx`).

## Env vars — **NOT added to `.env.example`** (sandbox permission denial)

`.env.example` is outside this agent's writable/readable sandbox path this session (both Read
and Edit were denied). Documenting here per the fallback instruction:

```
# Email notifications (Slice P1.3) — Resend (https://resend.com). Unset = notifications
# are silently skipped (StubEmailProvider logs "would send", never sends, never throws).
EMAIL_API_KEY=
EMAIL_FROM=
```

A human with repo write access should add these two lines to `.env.example` (with the usual
comment about TEST-mode / never committing real keys) before this slice is considered fully
landed.

## Deferred (explicitly out of scope for this slice)

- SMS / push channels (schema forward seam exists: widen `notification_log.channel`'s CHECK).
- Digest batching (currently one email per event, immediately).
- Per-org sender domains / DKIM / custom branding (currently one global `EMAIL_FROM`).
- A real operator-configurable "ops notify list" for `squawk.reported` / `aircraft.grounded`
  (see the recipient-simplification note above) — replaces the current self-notify posture.
- Tail-number display in `reservation.created` (currently raw resource ids — a display polish,
  not a compliance issue).
- Retry/backoff on transient provider failures (currently one attempt; a `failed` log row is
  the record, no automatic retry).

## Compliance posture

No FAA/airworthiness/currency/Part-61/141/91/43 determination language in any template (unit-
tested: `notifications.test.ts` asserts the grounding/squawk templates don't contain
"faa"/"part 91"). No money/collections advice in `payment.failed` — states the fact and points
the member back to the operator. `notification_log` never stores PII beyond the recipient
email + a short subject line (no rendered body).

## Verification

- `pnpm --filter @aeroops/db typecheck` — clean.
- `pnpm --filter @aeroops/api typecheck` — clean.
- `pnpm --filter @aeroops/web typecheck` — clean.
- `pnpm --filter @aeroops/core test` — 1000 passed (unchanged from before this slice).
- `pnpm --filter @aeroops/api test` — 1591 passed (was ~1569 before this slice's +22 new
  tests in `notifications.test.ts`).
- `git diff HEAD -- packages/api/src/dispatch/open-dispatch.ts` — empty (byte-identical).
- `git diff HEAD -- packages/api/src/scheduling/internal.ts` — empty (byte-identical;
  `gatedCreateOccurrence` untouched).
