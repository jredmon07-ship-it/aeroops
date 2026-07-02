# Slice QB1 — QuickBooks Online integration foundation

**Bookkeeping EXPORT only. NOT a payment processor. NEVER moves money.** Pushes operator-created, already-
finalized Slice B1 invoice records into the operator's own connected QuickBooks Online (QBO) company file,
one org at a time, self-serve OAuth2-connected, with each invoice line item mapped by kind to its own QBO
Item/GL account ("real-time line-item GL mapping" — the competitive wedge vs. Flight Circle's lump-sum,
few-times-a-day batch export). Migration `0021` staged + human-gated, NOT applied.

## Scope (built)
- **Schema** (migration `0021_qbo_integration.sql` + `.down.sql`): `qbo_connection` (one OAuth2 connection per
  org, `org_id` UNIQUE; tokens PLAINTEXT — `[VERIFY-QB1-SEC-1]` encryption-at-rest is a flagged production
  follow-up), `qbo_export_log` (APPEND-ONLY push-attempt history, SELECT+INSERT RLS only, mirrors
  `dispatch_ticket_correction`; partial UNIQUE `(org_id,entity_type,entity_id) WHERE status='exported'` is the
  idempotency backstop), `qbo_account_mapping` (per-org, per-`line_kind` → QBO Item id/name; UNIQUE
  `(org_id,line_kind)`). All three ENABLE+FORCE RLS via the standard org-scoped policy predicate.
- **`line_kind` domain** (`integrations/qbo/line-kind.ts`, mirrors the migration CHECK): `wet_hourly` |
  `dry_hourly` | `instruction` | `flat` (== `rate_schedule.rate_kind`, migration 0019 — FROZEN, not extended
  here) + `other` (invoice lines with no `rate_schedule_id` — manual/ad-hoc charges) + `default` (an optional
  operator-set catch-all mapping row). `[VERIFY-QB1-B]`: a future slice could add dedicated `rate_kind` values
  (e.g. `landing_fee`, `fuel_surcharge`) as first-class kinds for finer GL splits — additive, not required here.
- **Provider seam** (`integrations/qbo/client.ts`) — mirrors the house CAPTCHA-seam pattern: `QboClient`
  interface (`createCustomer` / `createInvoice` / `exchangeAuthCode` / `refreshTokens`), `StubQboClient`
  (default when `QBO_CLIENT_ID`/`QBO_CLIENT_SECRET` unset — every call throws `QboNotConfiguredError`, callers
  convert to a typed `{ ok:false, reason:'not_configured' }`, never a crash), `RealQboClient` (fetch-based,
  sandbox `https://sandbox-quickbooks.api.intuit.com` / production `https://quickbooks.api.intuit.com`,
  OAuth2 `https://appcenter.intuit.com/connect/oauth2` authorize + `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`
  token endpoint — confirmed against Intuit's own `oauth-jsclient` SDK source, 2026-07). `getQboClient()` is a
  memoized per-process selector; commands accept an optional injected `QboClient` so tests never make real HTTP calls.
- **Pure mapper** (`integrations/qbo/map-invoice.ts`, property-tested) — `mapInvoiceToQboPayload`: each
  AeroOps line item becomes its OWN QBO `Line` (`SalesItemLineDetail`) with the `ItemRef` resolved from
  `accountMap[line.lineKind] ?? accountMap['default']`; if ANY line's kind resolves to neither, the WHOLE
  export is refused (`{ ok:false, reason:'unmapped_kinds', kinds }`) — never a silent lump into one line.
  Money: integer cents → a 2-decimal dollar string via integer subtraction/modulo only (never
  `cents / 100` float division), `Number(...)` is the unavoidable, lossless JSON-transport parse of that
  already-exact string. `DocNumber = "AO-" + first 8 hex chars of the invoice id` (Slice B1 has no dedicated
  invoice-number column — `[VERIFY-QB1-DOC]`). `PrivateNote` embeds the AeroOps invoice id verbatim.
- **Commands** (`integrations/qbo/*`, all `*WithDb` test forms + zod-validated + audited):
  - `getQboStatus` (`billing:access`) — connection status (NEVER tokens) + last 20 export-log rows + current
    mapping + `providerConfigured` (env-only check).
  - `setQboAccountMapping` / `deleteQboAccountMapping` (`org:manage_settings`) — per-kind mapping CRUD, audited.
  - `buildQboAuthorizeUrl` / `completeQboOAuth` / `disconnectQbo` (`org:manage_settings`) — OAuth2 handshake.
    `state` is a short-lived signed token (`integrations/qbo/state.ts`, reuses `AUTH_SECRET` via the same
    `next-auth/jwt` encode/decode format as `auth/mobile-token.ts`) bound to `(orgId, userId)`, minted from the
    caller's OWN session at `buildQboAuthorizeUrl`-time. `completeQboOAuth` re-`requireCapability`s AND
    cross-checks the decoded state against the CURRENT session before any DB write — `org_id` is NEVER taken
    from the OAuth callback's query string.
  - `exportInvoiceToQbo` (`billing:manage`) — loads the invoice (must be `finalized`; draft/void refused);
    idempotency check against `qbo_export_log` (already `exported` → returns the existing `qboId`, no
    re-push); ensures a QBO Customer exists (reuse-or-create + logged); refreshes the access token if
    expiring (via `client.refreshTokens`); builds the payload via the pure mapper; pushes via `client.createInvoice`.
    Every attempt writes a `qbo_export_log` row (`'exported'` with `qboId`, or `'error'` with a truncated
    provider-error detail — errors are NEVER silently swallowed) + ONE `audit_log` row. On an unconfigured
    client (env unset) → clean typed `{ ok:false, reason:'not_configured' }`.
- **Web** (`apps/web`): `/api/integrations/qbo/connect` + `/api/integrations/qbo/callback` (Node-runtime thin
  adapters — no SQL, session-derived redirects only); a QuickBooks card on `/o/[slug]/settings` (status +
  Connect/Disconnect + the per-kind mapping editor + the last-20 export-activity log — the visible, self-serve
  sync log that beats a black-box batch export); a minimal `/o/[slug]/billing` invoice list + detail (B1 had no
  UI yet — built here as a deviation-with-reason to give the QB1 "Export to QuickBooks" action a home) with
  Finalize/Void (existing B1 commands, unchanged) + the new Export button on finalized invoices, success/error
  surfaced inline. New `Billing` nav item (`billing:access`: owner/manager/accountant).

## Deferred (explicitly out of scope for QB1)
- **Webhooks** — no inbound QBO webhook consumer (e.g. payment-received sync-back). Export is one-directional,
  operator-initiated only.
- **Two-way sync** — AeroOps never reads QBO state back (no reconciliation, no drift detection).
- **Payments sync** — QBO payment/receipt records are not touched; this is invoice-record export only.
- **Token encryption at rest** — `[VERIFY-QB1-SEC-1]`, flagged for before production use.
- **Batch / auto-export on finalize** — export is a manual, explicit per-invoice action today. The natural next
  seam: an opt-in "auto-export on finalize" org setting that calls the SAME `exportInvoiceToQbo` command from
  inside `finalizeInvoice`'s transaction (or a queued follow-up job) — deferred so the manual flow ships first
  and the idempotency/error-log plumbing is proven before anything runs unattended.
- **Customer/member ↔ QBO Customer dedup beyond one org** — the customer-reuse check is per-org via
  `qbo_export_log`; no cross-org QBO Customer matching.

## Founder deploy steps
1. Create an Intuit developer app at <https://developer.intuit.com> (Accounting API scope).
2. Grab the sandbox `Client ID` / `Client Secret`; set `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` in the deployment env.
3. Set `QBO_REDIRECT_URI` to `https://<domain>/api/integrations/qbo/callback` and register that EXACT URI in
   the Intuit app's redirect-URI allowlist.
4. `QBO_ENVIRONMENT=sandbox` for testing; `production` (+ a production Intuit app + production keys) to go live.
5. Apply migration `0021_qbo_integration.sql` (human-gated, after review) before any org can connect.
6. An owner/manager visits Org settings → QuickBooks card → Connect, approves on Intuit's consent screen, sets
   the per-kind account mapping, then uses "Export to QuickBooks" on a finalized invoice.

## Tests
- `packages/api/src/__tests__/qbo-map-invoice.test.ts` — 15 tests: unit edges (empty lines, per-kind ItemRef
  never lumped, `default` fallback, unmapped-kinds refusal + dedup, total-mismatch refusal, DocNumber/PrivateNote)
  + 5 fast-check properties (per-line Amount round-trips to the exact original cents; sum of per-line Amounts
  equals invoice `totalCents`; ItemRef matches the per-line kind; unmapped-kind detection; determinism).
- `packages/api/src/__tests__/qbo-integration.test.ts` — 35 tests against PGlite (migrations 0000–0021) with a
  hand-rolled `FakeQboClient` (zero real HTTP calls): capability gates (`billing:access` / `billing:manage` /
  `org:manage_settings`, null-session Unauthenticated, wrong-role Forbidden) × all five commands; account-mapping
  upsert/delete + audit; OAuth connect (valid state → connects + audit; mismatched state → refused before any
  DB write; missing `QBO_REDIRECT_URI` → `not_configured`) + disconnect (nulls tokens, audited); export happy
  path (per-line ItemRef verified in the actual client payload) + idempotent double-export (client NOT called
  again) + draft-invoice refusal + unmapped-kind refusal (writes an `error` log row) + provider-error handling
  (writes an `error` log row + audit, never swallowed) + the stub-client `not_configured` path (both the direct
  `StubQboClient` unit check and the token-refresh-triggers-stub integration path) + tenant isolation (org A
  cannot see org B's connection/export-log/mapping, cannot export an org-B invoice id, disconnecting org A does
  not touch org B).
- `apps/web/lib/__tests__/nav.test.ts` — extended for the new `Billing` nav item (visibility + ordering).

## Guardrails held
Tenant isolation (`org_id` from session only, RLS backstop, adversarially tested in T-ISO). Secrets in env only
(`QBO_CLIENT_ID`/`QBO_CLIENT_SECRET`/`QBO_REDIRECT_URI`/`QBO_ENVIRONMENT`, already present in `.env.example`).
Webhooks n/a (no inbound webhook in this slice). Every provider call wrapped — outages/errors never crash,
always a typed refusal + a logged row. No Date interpolated into raw SQL (all writes via Drizzle's query
builder, no hand-written `sql\`\`` templates with Date params in this slice). PCI: untouched — QBO holds no
card/bank data either; this is bookkeeping metadata only.
