# Phase-2 Billing — Architecture & Design + ADR-0015 (Stripe) — FOUNDER DECISION PACKET

**DESIGN. The money boundary (CLAUDE.md/THE-BIBLE §11) stays until the founder says go AND provides Stripe test keys.**
This is a swap-in onto existing seams (3c balance stub + flag, ADR-0007 records-immutable, ADR-0001 RLS), NOT a re-architecture.

## The safe split (the key finding)
**~2/3 of Phase-2 billing is records + PURE MATH that crosses NO boundary and needs NO keys** — buildable NOW behind the
OFF flag, migrations staged-not-applied, exactly like 3c shipped the balance flag+stub in Phase 1:
- **B1 (no keys):** `rate_schedule` / `pricing_group` / `invoice` / `invoice_line_item` tables (RLS/audit/composite-FK like
  work_order/squawk; amounts = operator-entered INTEGER CENTS, never floats) + pure `computeInvoiceTotals`/`applyRate`/
  `applyPricingGroup` in @aeroops/core (**property-tested** — hard guardrail) + `generateInvoiceFromDispatch` DRAFT path
  (reads the existing write-once `flight_time_hours`, NEVER recomputes; FROZEN dispatch path byte-identical).
- **B2 (no keys):** `account` + append-only `ledger_entry` (SELECT+INSERT RLS only, audit_log pattern) + pure
  `computeBalance(entries)` (property-tested) + the **real `stripeBalanceSeam` LOGIC** (reads OUR ledger, not Stripe — so
  fully buildable/testable now) — but NOT injected into openDispatch; the stub stays injected + `balance_check_enabled` OFF
  → the FROZEN dispatch gate stays BYTE-IDENTICAL.
- **NEEDS founder go + Stripe TEST keys (B3):** the Stripe SDK, `stripe_customer`/SetupIntent (card-on-file)/PaymentIntent
  (charge), the idempotent webhook handler (`stripe_event` dedup), refunds (B5); + the ONE-LINE seam swap
  (stub→stripeBalanceSeam at open-dispatch.ts:338) + flipping `balance_check_enabled`/`minimum_balance_cents` = the boundary lift.

## ADR-0015 — Stripe integration shape (PROPOSED; needs founder go + keys)
- **PaymentIntents + per-org Customer + SetupIntent on a SINGLE PLATFORM account; NOT Connect** (correct for one-operator-
  per-tenant; operator is merchant of record). **[VERIFY-B-CONNECT] = the ONE expensive-to-reverse decision** — revisit only
  if the model becomes a true marketplace (AeroOps billing renters on the operator's behalf + payouts).
- **NEVER store raw card/bank data** — Stripe Elements/hosted fields only (PCI **SAQ-A**); persist only customer_id/pm_token/
  payment_intent_id/last4/brand (Stripe-permitted display) + our own ids.
- **Webhooks are the source of truth** (charge "settled" only on verified `payment_intent.succeeded`; never the client
  response). **Idempotent** (dedup on Stripe event.id; deterministic idempotency keys `payment:<uuid>` → no double-charge).
- **Records immutable (mirrors ADR-0007):** finalized invoices/payments/ledger entries are write-once; corrections =
  reversing entries / credit memos (append-only), NEVER UPDATE/DELETE. One audit_log row per money mutation.
- **Money rows are tenant rows:** org_id + ENABLE+FORCE RLS (append-only tables = SELECT+INSERT only) + UNIQUE(id,org_id) +
  composite FKs + aeroops_app grant; withSessionOrgContext; apps/web never imports @aeroops/db. **[VERIFY-B2-PORTAL]:** a
  renter sees ONLY their own invoices/balance (intra-org self-scope ON TOP of RLS, like the P1 portal) — adversarially tested.
- Keys in env ONLY (test → live is a separate later gate). Money stored as integer minor units (cents).

## Sub-slice sequence
B1 rate/invoice records + invoice math → B2 ledger + real balance-gate LOGIC (gate stays OFF) → **[boundary lift]** B3
Stripe PaymentIntents/card-on-file/webhooks → B4 block-time → B5 refunds/credits → B6 QBO export. Migrations 0018+ (0015–
0017 are booking/PB-LR). All human-gated.

## Correction-table predecessor (load-bearing)
Billing CONSUMES the dispatch meters → per ADR-0007 §1 + [[dispatch-correction-table-predecessor]], build the append-only
`dispatch_ticket_correction` table BEFORE B1 invoices a meter (else a wrong invoiced meter is a money dispute, not just a
records gap). **Recommendation: build the correction table first.** Alternative: accept "fix via credit memo + re-invoice."

## Boundary-lift checklist (nothing happens until each is met, top-down)
1☐ founder explicit go · 2☐ Stripe TEST keys in env · 3☐ webhook endpoint + signature + stripe_event dedup · 4☐ PCI SAQ-A
confirmed (no PAN path) · 5☐ B1+B2 merged+green (behind OFF flag) · 6☐ swap stub→stripeBalanceSeam (open-dispatch.ts:338) ·
7☐ per-operator opt-in (balance_check_enabled OFF until the operator opts in — lifting the boundary does NOT auto-enable
blocking) · 8☐ test-mode end-to-end proven · 9☐ live keys (separate later gate).

## [VERIFY] flags
[VERIFY-B-MONEY-1] derived flight time becomes the billable basis (ADR-0007 [VERIFY-A] now load-bearing for money) ·
[VERIFY-B-CORRECTION] correction-table-first vs credit-memo · [VERIFY-B-PCI] SAQ-A reviewer confirm before B3 ·
[VERIFY-B-CONNECT] platform-vs-Connect · [VERIFY-B2-PORTAL] renter intra-org self-scope · [VERIFY-B-PRICING-GROUP]
structured pricing_group (recommended) vs free-text tag · [VERIFY-B-TAX] sales tax deferred (hand-entered line) ·
Part-141 retention carried from ADR-0007 [VERIFY-C].

## Hooks (files): balance-seam.ts (interface unchanged), open-dispatch.ts:338 (the one-line swap), dispatch/types.ts:101
(the RESERVED balance_block arm becomes reachable), dispatch-gate/config.ts (balance_check_enabled + minimum_balance_cents),
close-dispatch.ts (flight_time_hours basis — B1 consumes, never recomputes), dispatch-ticket/audit-log/work-order/squawk
schemas (the RLS/append-only/immutable patterns billing copies).

## BOTTOM LINE
Founder can authorize **B1+B2 now (records + ledger + all pure money math, property-tested, OFF flag, migrations staged-not-
applied) with NO keys, NO Stripe, NO real money** — de-risking the boundary lift to a small isolated B3 (Stripe wiring +
one-line swap + config flip). Only platform-vs-Connect is expensive to reverse (recommend platform). Founder authorized
"build all you can on your own" → building B1 (+ the correction-table predecessor) + B2-records as the safe foundation; B3
held for explicit go + test keys.
