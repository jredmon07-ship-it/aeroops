> Removed 2026-10-10: money features were removed from AeroOps; kept as a design record.

# Slice B2 + B3-foundation — Billing ledger, balance, and the Stripe seam-to-the-key-boundary

**STATUS: BUILD-COMPLETE, human-gated.** Migrations `0022_billing_ledger.sql` + `0023_stripe_foundation.sql`
staged, **NOT applied** anywhere. `main`/live-deploy untouched. Maintainer gave explicit go for the
money-processor work; Stripe TEST keys are **not yet provided**, so B3 stops at the key boundary exactly
like the QBO (`integrations/qbo/client.ts`) and CAPTCHA (`booking/captcha.ts`) seams: a stub that throws a
typed `*NotConfiguredError` on every call when the relevant env var is unset. **NO real Stripe HTTP call
exists anywhere in this codebase today** — every test injects a fake `StripeClient`.

This document supersedes the B2/B3 sections of `phase2-billing-design.md` (ADR-0015) with the as-built
state. Read `phase2-billing-design.md` first for the original architecture decision (platform-not-Connect,
webhooks-as-truth, SAQ-A, the B1/B2-vs-B3 split) — that decision stands unchanged.

---

## 1. Scope

### B2 — ledger + balance (NO keys, fully live logic, gate stays OFF)
- `billing_account` (one ledger account per org+member, lazily created) + `ledger_entry` (APPEND-ONLY
  debit/credit history, migration `0022`).
- Pure `computeBalance(entries)` in `@aeroops/core` (`packages/core/src/billing/ledger-math.ts`) —
  `balance = Σcredits − Σdebits`, property-tested (permutation invariance, append monotonicity, integer
  closure, reversal cancellation, and 6 more).
- `getMemberBalance` / `listLedgerEntries` (`billing:access`, keyset-paginated) — the balance is **always
  derived**, never stored/cached.
- `recordManualPayment` (`billing:manage`, audited) — an operator logs a check/cash/external payment; posts
  one `'payment'` credit `ledger_entry`. **This alone makes the balance gate meaningful with ZERO Stripe.**
- `finalizeInvoice` (existing B1 command, `packages/api/src/billing/invoice-status-commands.ts`) is
  **additively extended**: finalizing now posts one `'invoice_finalized'` debit `ledger_entry` in the
  **same transaction** as the status UPDATE. Idempotent via a partial `UNIQUE (org_id, invoice_id,
  entry_type) WHERE entry_type='invoice_finalized'` index — an invoice can generate at most one debit,
  structurally, not just by application check. A `$0` invoice finalizes with **no** ledger entry
  (`ledger_entry.amount_cents` has a `CHECK > 0` — a zero-value row is never legal).
- `dispatch_config.minimum_balance_cents` (additive integer-cents column, default `0`) — operator-set
  threshold, exposed through the existing `updateDispatchConfig`/`getDispatchConfig` commands. **DATA
  ONLY** in this slice.
- `realBalanceSeam` / `makeRealBalanceSeam(db)` (`packages/api/src/billing/real-balance-seam.ts`) — a
  **real**, ledger-backed implementation of `@aeroops/core`'s `BalanceSeam` interface (same shape as
  `stubBalanceSeam`). **Fully built and tested. NOT injected anywhere in app code.**
  `openDispatch()`'s app-code form (`packages/api/src/dispatch/open-dispatch.ts:337-338`) still
  hard-codes `stubBalanceSeam`, byte-identical to before this slice. A dedicated test
  (`FROZEN gate byte-identity` in `billing-ledger.test.ts`) proves this: it seeds a deeply-negative
  ledger balance, sets `balanceCheckEnabled=true` and a high `minimumBalanceCents`, independently confirms
  `makeRealBalanceSeam` *would* refuse the pilot, then calls `openDispatchWithDb` **with no injected
  seam** and asserts it still succeeds.

### B3-foundation — Stripe seam to the key boundary
- `stripe_customer` / `stripe_event` (global append-only dedup ledger, `event_id` **is** the primary key)
  / `payment_intent_record` (migration `0023`). **No PAN/CVV/account-number column anywhere** — only
  Stripe's own ids + Stripe-permitted `last4`/`brand` display fields (PCI SAQ-A).
- `StripeClient` interface + `StubStripeClient` (throws `StripeNotConfiguredError` on every call, default
  when `STRIPE_SECRET_KEY` is unset) + `RealStripeClient` (raw `fetch` against `api.stripe.com`, form-
  encoded, HTTP Basic auth — **no `stripe` npm package**, to keep the Vercel serverless bundle free of a
  large SDK; mirrors the QBO client's "raw fetch, no SDK" posture).
- `verifyStripeSignature` (`packages/api/src/integrations/stripe/webhook-verify.ts`) — **pure**, framework-
  agnostic HMAC-SHA256 signature verification per Stripe's documented algorithm (confirmed against
  `docs.stripe.com/webhooks/signatures`, 2026-07): parses `t=`/`v1=` pairs (ignores legacy `v0=` —
  downgrade-attack protection), constant-time-compares against **every** `v1` candidate (Stripe sends
  multiple during a secret-rotation window), rejects timestamps outside a 300s tolerance (replay
  protection). 23 unit/property tests: valid-sig passes, tampered-payload fails, replayed-timestamp fails,
  missing/malformed header, garbage/wrong-length signature, custom tolerance, boundary conditions.
- `createInvoicePaymentIntent` (`billing:manage`, **staff-initiated** in this slice — not a payer-facing
  self-serve flow yet) — ACH-first (`payment_method_types` defaults to `['us_bank_account', 'card']`),
  idempotent per invoice (a `pending`/`processing`/`succeeded` record blocks a second PaymentIntent; a
  prior `failed`/`canceled` record does not block a retry). Ensures a `stripe_customer` exists (reused
  across invoices for the same member). **Never settles anything** — the returned `client_secret` is only
  what the browser needs for Stripe-hosted fields.
- `getPaymentStatus` (`billing:access`, READ-ONLY) — reads **our own** `payment_intent_record`; does
  **not** call Stripe. This is deliberate: webhooks are the source of truth (ADR-0015), so there is no
  client-triggered "refresh from Stripe" in this slice.
- `handleStripeWebhookEvent` — **the only place a webhook is ever processed.** Verify signature → dedup
  (`INSERT INTO stripe_event` first; `event_id` PK collision ⇒ already processed ⇒ 200, no reprocessing) →
  on `payment_intent.succeeded`, resolve the org via `resolveOrgByStripePaymentIntentId` (a **sanctioned
  platform-admin read** — see §3 below) → inside `withOrgContext`, guarded `UPDATE ... WHERE status <>
  'succeeded'` on `payment_intent_record` → post **one** `'payment'` credit `ledger_entry`
  (`createdBy = null`, mirrors `audit_log.actor_user_id`'s nullable "System" convention) → one audit row.
  The dedup INSERT is **unconditional** — it fires for every event type, so a replay of *any* previously-
  seen event (regardless of type) is a guaranteed no-op.
- `apps/web/app/api/integrations/stripe/webhook/route.ts` — thin Node-runtime transport adapter. Reads
  `request.text()` (the **raw**, byte-exact body — never `request.json()`, which would break signature
  verification). Maps `not_configured` → HTTP 503 (Stripe retries) with a loud server log; `invalid_signature`
  → HTTP 400 (Stripe does not retry a 4xx by default — correct, a forged request should never be retried);
  success/dedup → HTTP 200.

---

## 2. ACH-first rationale + fee shape

`createInvoicePaymentIntent` defaults `payment_method_types` to `['us_bank_account', 'card']` — ACH bank
debit is offered first, with card as a same-PaymentIntent fallback. **[VERIFY]** confirmed against Stripe's
publicly documented pricing as of the design conversation: US ACH direct debit via Stripe is materially
cheaper than card (~0.8%, capped at $5/transaction) vs. card's ~2.9% + 30¢. For a $300 rental-hour invoice
this is a real margin difference for the operator (card: ~$9.00 fee; ACH: ~$2.40 fee, capped). **[VERIFY-B3-FEE]**:
exact current Stripe pricing/caps should be reconfirmed against the Stripe dashboard at deploy time — fee
schedules can change and vary by account/region; this document does not hardcode a fee number into any
code path (no fee is computed or charged by AeroOps — Stripe bills the operator's own Stripe account
directly per Stripe's own pricing).

---

## 3. The sanctioned platform-admin reads (both narrowly scoped, both documented in-line)

Two functions in this codebase are permitted to use `withPlatformAdminContext` (which bypasses per-tenant
RLS by setting `app.platform_admin = 'on'`):

1. `resolveOrgBySlug` (`packages/api/src/auth/resolve-org.ts`, pre-existing, auth path).
2. **NEW:** `resolveOrgByStripePaymentIntentId` (`packages/api/src/integrations/stripe/resolve-payment-intent.ts`)
   — the Stripe webhook path's equivalent. A webhook delivery carries no AeroOps session; the **only**
   handle available is the (verified) event's Stripe PaymentIntent id, and `payment_intent_record` is a
   normal org-scoped table. `resolveOrgByStripePaymentIntentId` is READ-ONLY, single-row, fixed
   projection `{orgId, invoiceId, paymentIntentRecordId}`, keyed by the **globally unique**
   `stripe_payment_intent_id` column.

   This required one small, deliberate RLS change to migration `0023`: `payment_intent_record`'s
   `SELECT` policy additionally admits `current_setting('app.platform_admin', true) = 'on'` — mirroring
   the **exact same pattern** already used by `org_select` (migration `0000`, "FIX 4"). Every WRITE policy
   (UPDATE/INSERT/DELETE) on `payment_intent_record` stays org-GUC-only; platform-admin is READ-ONLY here.
   Every subsequent write (the ledger credit, the status UPDATE, the audit row) happens **only** inside
   `withOrgContext(db, resolvedOrgId, ...)` — the org_id used for that context comes from **our own**
   table, never from the Stripe payload's caller-suppliable `metadata`.

`stripe_event` (the dedup table) took a narrower, table-specific approach instead of the platform-admin
pattern: its `org_id` column is nullable, and its SELECT/INSERT policies admit `org_id IS NULL OR org_id =
GUC`. The dedup INSERT itself is wrapped in `withOrgContext(db, resolvedOrgId, ...)` when the org is
already known (satisfying the GUC-match branch) or left unwrapped with `org_id: null` when it is not yet
known (satisfying the NULL branch) — see `handle-webhook-event.ts` for the exact branching and its comment
explaining why an *unwrapped* insert with a *non-null* org_id would be rejected (GUC unset, neither policy
branch matches).

---

## 4. `ledger_entry.created_by` is nullable (a mid-build correction, still pre-human-review)

The original migration draft had `ledger_entry.created_by NOT NULL`. Building the webhook handler surfaced
that a **system-generated** credit (posted from a verified Stripe event, with no human actor) has nothing
legitimate to put there. Fixed **before** any human review of the migration: `created_by` is now nullable
(the composite FK to `app_user` only fires on non-null values — Postgres `MATCH SIMPLE` default, the same
pattern already used by `invoice.dispatch_ticket_id`), mirroring `audit_log.actor_user_id`'s existing
nullable "System" convention. Every human-initiated ledger write (`recordManualPayment`, `finalizeInvoice`)
still sets `created_by = session.userId`; only the webhook path sets it to `null`.

---

## 5. Collateral fix: 30 test files needed migration-list bumps

Every `*.test.ts` file that exercises `openDispatch`/`getDispatchConfig`/`updateDispatchConfig` applies a
cumulative list of migration SQL files against PGlite. `openDispatch` unconditionally calls
`loadDispatchConfig`, which now `SELECT`s the additive `minimum_balance_cents` column — so **every** test
file whose migration list stopped at `0019`/`0009` (but exercised any dispatch-gate code path) needed
`0020`/`0021`/`0022`/`0023` appended, exactly like every prior additive `dispatch_config` column
(`0010` twilight, `0014` availability, `0017` retention) required the same bump at the time. 30 files were
mechanically updated (script-driven, verified diff-by-diff); one test's assertion
(`dispatch-gate-api.test.ts`, "audit metadata does NOT contain any dollar value") was **narrowed, not
deleted** — it now asserts no Stripe/card/bank/payment-processor concept appears in `dispatch_config`'s
audit metadata, while explicitly allowing the one reviewed `minimumBalanceCents` field. All 1524
`@aeroops/api` tests pass; the FROZEN dispatch/twilight/eligibility/availability gate tests are
byte-identical in behavior (the only change is *which columns get selected*, not what the gate does).

---

## 6. Boundary-lift checklist — state (per ADR-0015 §"Boundary-lift checklist")

| # | Item | Status |
|---|------|--------|
| 1 | Maintainer explicit go | ✅ Given (this build) |
| 2 | Stripe TEST keys in env | ❌ **Maintainer step.** `.env.example` already scaffolds `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` (placeholders, pre-existing) — fill in `sk_test_...`/`pk_test_...` and set `STRIPE_WEBHOOK_SECRET` after step 3. |
| 3 | Webhook endpoint + signature + `stripe_event` dedup | ✅ **Code-complete.** Route built (`apps/web/app/api/integrations/stripe/webhook/route.ts`), signature verification unit/property-tested, dedup structurally enforced (PK collision). Maintainer still needs to **register the endpoint URL in the Stripe dashboard** to mint the actual `STRIPE_WEBHOOK_SECRET` (chicken-and-egg with item 2 — register first, then set the secret it gives you). |
| 4 | PCI SAQ-A confirmed (no PAN path) | ✅ No PAN/CVV/account-number column or code path anywhere in this slice — [VERIFY-B-PCI] compliance sign-off still recommended before go-live, per the original design doc. |
| 5 | B1+B2 merged+green (behind OFF flag) | ✅ B1 pre-existing; B2 built+tested this slice, 1524/1524 `@aeroops/api` tests green, `balance_check_enabled` stays operator-set default `false`. |
| 6 | Swap stub→`realBalanceSeam` at `open-dispatch.ts:338` | ❌ **NOT done, by design.** This is the ONE code change explicitly deferred to a separate, later, human-reviewed diff (a one-line seam swap). `realBalanceSeam`/`makeRealBalanceSeam` is fully built and tested; only the injection point is untouched. |
| 7 | Per-operator opt-in (`balance_check_enabled` OFF until opt-in) | ✅ Unaffected by this slice — default stays `false`; flipping it currently still has zero effect (item 6 not done). |
| 8 | Test-mode end-to-end proven | ❌ **Maintainer step** — needs real Stripe TEST keys + the Stripe CLI or dashboard test-mode webhook trigger; cannot be done in this sandboxed environment (no real Stripe call is ever made in this build). |
| 9 | Live keys (separate later gate) | ❌ Not started — correctly out of scope until 1–8 are all done in test mode first. |

**Bottom line:** items 1, 3 (code), 4, 5, 7 are met. Item 2 (keys) and item 8 (prove it end-to-end) are the
maintainer's next concrete steps, in that order — register the webhook endpoint in the Stripe dashboard
(mints the webhook secret), set all three env vars, run a test-mode payment end-to-end using Stripe's
test card/bank numbers, THEN (item 6) request the one-line seam swap as its own reviewed diff, THEN (item 7)
decide per-operator whether `balance_check_enabled` should default off (recommended) or require explicit
operator opt-in through the UI.

---

## 7. [VERIFY] flags carried / added

- **[VERIFY-B-MONEY-1]** (carried, ADR-0007/ADR-0015): derived flight time is the billable basis — unchanged,
  read-only in this slice.
- **[VERIFY-B2-PORTAL]** (carried): a renter/student must see **only** their own balance/ledger if this is
  ever exposed through the P1 portal — **NOT done in this slice** (accounts view is staff-only, gated on
  `billing:access`/`billing:manage`, under `/o/[slug]/billing/accounts/*` — never under `/portal`).
- **[VERIFY-B-PCI]** (carried): SAQ-A compliance reviewer confirm before any live Stripe key is used.
- **[VERIFY-B-CONNECT]** (carried, already decided): platform account, not Connect — unchanged.
- **[VERIFY-B3-FEE]** (new, §2 above): reconfirm current Stripe ACH/card pricing at deploy time.
- **[VERIFY-B3-RETRY]** (new): this slice does not implement a Stripe retry/backoff queue for
  `createPaymentIntent`/`createCustomer` HTTP failures beyond returning a typed `provider_error` to the
  staff caller — CLAUDE.md's "queue + retry" guidance for provider outages is currently satisfied only at
  the webhook layer (Stripe's own retry-on-5xx/503 behavior) and by the command being safely re-callable
  (idempotent) by the operator; a proper background retry queue is a forward seam, not built here.
- Part-141 billing-record retention (carried from ADR-0007 [VERIFY-C]): unaffected, no new retention
  question introduced by the ledger (append-only, same posture as `audit_log`).

---

## 8. Files (for reference)

**Migrations (staged, human-gated, NOT applied):**
`packages/db/migrations/0022_billing_ledger.sql` (+`.down.sql`),
`packages/db/migrations/0023_stripe_foundation.sql` (+`.down.sql`).

**`@aeroops/core`:** `packages/core/src/billing/ledger-math.ts` (`computeBalance`) +
`packages/core/src/__tests__/ledger-math.test.ts` (26 tests, P1–P10 properties).

**`@aeroops/db` schema:** `billing-account.ts`, `ledger-entry.ts`, `stripe-customer.ts`, `stripe-event.ts`,
`payment-intent-record.ts`; additive `dispatch-config.ts` column.

**`@aeroops/api`:**
`billing/ledger-internal.ts`, `billing/ledger-account.ts`, `billing/record-manual-payment.ts`,
`billing/real-balance-seam.ts`, additive edit to `billing/invoice-status-commands.ts`;
`integrations/stripe/{client,webhook-verify,resolve-payment-intent,create-payment-intent,get-payment-status,handle-webhook-event}.ts`;
additive edits to `dispatch-gate/{types,internal,config}.ts` (`minimumBalanceCents` plumbing only — the
gate itself, `dispatch/open-dispatch.ts`, is untouched).

**Tests:** `packages/api/src/__tests__/billing-ledger.test.ts` (25),
`packages/api/src/__tests__/stripe-webhook-verify.test.ts` (23),
`packages/api/src/__tests__/stripe-foundation.test.ts` (20); 30 pre-existing test files' migration lists
bumped (see §5).

**Web:** `apps/web/app/api/integrations/stripe/webhook/route.ts`;
`apps/web/app/o/[slug]/(shell)/billing/accounts/[memberId]/page.tsx` +
`.../accounts/_components/account-detail-client.tsx`; additive edits to `billing/actions.ts` and
`billing/_components/invoice-detail-client.tsx` (a "View member account" link).
