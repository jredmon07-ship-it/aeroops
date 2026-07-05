# Slice B4 — Block-time / prepaid packages

**Status:** build-complete, awaiting human review. Migration `0034_block_time.sql` +
`.down.sql` are STAGED and human-gated — **NOT applied** to any database.

## What this is

"Block time" (THE-BIBLE glossary) = a prepaid, discounted hour bundle a member buys
up front and draws down as they fly. This slice lets an operator:

1. Define a **block package** offering (e.g. "10-hour Archer block — $1,500").
2. **Sell a block** to a member — either from a package, or an ad-hoc hours+amount
   sale — which posts an **operator-recorded credit** on the member's existing
   billing ledger (exactly like `recordManualPayment`, Slice B2).
3. See a **member block summary**: hours/amount purchased, remaining prepaid
   balance, and purchase history — from the staff side (`billing:access`) and from
   the member's own self-service portal (`portal:access`).

## Money boundary — what this explicitly does NOT do

- **No Stripe.** No card/bank data is ever collected, stored, or transmitted. A
  block sale RECORDS that a member paid (operator-attested) — it does not process
  a payment. Selling a block through the Stripe rail is a distinct, founder-gated,
  future money-boundary-lift step (mirrors ADR-0015's B2-vs-B3 split).
- **No tax/GAAP/FAA determination.** This is an operator billing record, full stop.
- **Integer cents only.** `price_cents` / `amount_cents` are `integer`, `CHECK > 0`.
  `hours` is `numeric(10,1)` — a QUANTITY, not money — mirroring
  `invoice_line_item.quantity_hours` exactly.

## How it rides the existing ledger (Slice B2)

A block sale posts **exactly ONE** new `ledger_entry` row:

- `entry_type = 'block_purchase'` (NEW — see below)
- `direction = 'credit'`
- `amount_cents = <the sale's amount>`

This is the same table/mechanism `recordManualPayment` posts a `'payment'` credit
to. `computeBalance` (`@aeroops/core`) already nets every credit against every
`'invoice_finalized'` debit — a block-purchase credit **raises** the member's
derived balance the exact same way a manual payment does, and the **existing**
invoice-finalize debit path (frozen, untouched) draws it down automatically.

### Why a distinct `entry_type` (`'block_purchase'`) instead of reusing `'payment'`

So reporting/AR can tell a prepaid block sale apart from an ad-hoc manual payment
or a Stripe-verified payment at a glance, without inspecting `memo`/`payment_id`
heuristically. Migration `0034` widens `ledger_entry.entry_type`'s `CHECK`
constraint additively (`DROP` + `RECREATE` with the wider domain) — safe because no
`'block_purchase'` row can exist before this migration runs.

## Schema (migration `0034_block_time.sql`)

- **`block_package`** — operator-defined offering. MUTABLE, standard 4-policy RLS
  (byte-identical shape to `product_catalog`, migration `0031`). The **effective
  discounted rate** (`price_cents / hours`) is **DISPLAY ONLY** — computed by the
  application layer (`computeEffectiveRateCentsPerHour`, `@aeroops/core`), never
  stored.
- **`block_purchase`** — APPEND-ONLY (SELECT + INSERT RLS only, mirrors
  `ledger_entry` / `dispatch_ticket_correction`). SNAPSHOTS `hours` +
  `amount_cents` at sale time; `package_id` is nullable (ad-hoc sales allowed) and
  never retroactively altered by a later package edit.
- `ledger_entry.entry_type` CHECK widened to include `'block_purchase'`.

## Backend (`packages/api/src/billing/`, `packages/api/src/portal/`)

- `createBlockPackage` / `updateBlockPackage` / `deactivateBlockPackage` /
  `listBlockPackages` — cap `billing:manage` for writes, `billing:access` for
  reads. No hard-delete command in this slice (a package with purchases must
  never disappear from reporting — `deactivateBlockPackage` is the only
  retirement path).
- `sellBlockToMember` — cap `billing:manage`. ATOMICALLY (one tx,
  rollback-on-any-failure): resolves a package sale or an ad-hoc
  hours+amountCents sale → `INSERT`s ONE `block_purchase` row → posts ONE
  `'block_purchase'` credit `ledger_entry` → ONE audit row. Idempotency is not
  required (each sale is a distinct event); atomicity is (no orphaned purchase
  without its ledger credit, or vice versa).
- `getMemberBlockSummary` (staff, `billing:access`) / `getMyBlockSummary` (portal
  self-view, `portal:access`) — purchase totals via the pure, property-tested
  `aggregateBlockPurchases` (`@aeroops/core`), plus
  `prepaidBalanceCents = max(0, computeBalance(...))` — the member's remaining
  ledger credit, **never shown negative** (a member who owes money is the AR
  report's job, not this one). Both views share the same reader
  (`billing/block-time-internal.ts`, not barrel-exported) so they can never
  disagree.

## Pure math (`packages/core/src/billing/block-summary-math.ts`)

- `aggregateBlockPurchases` — Σ hours (exact, via an integer-tenths accumulator —
  the same convention `packages/api/src/logbook/internal.ts`'s `buildPilotLog`
  uses to avoid float drift) + Σ amountCents (integer-closed, property-tested).
- `computeEffectiveRateCentsPerHour` — `price_cents / hours`, rounded to the
  nearest cent for display. **Never** summed, stored, or fed back into further
  money math.

## Web

- `/o/[slug]/billing/block-time` — package catalog (CRUD) + "Sell a block" (pick
  member + package, or ad-hoc hours+amount).
- `/o/[slug]/billing/block-time/[memberId]` — staff per-member summary + history.
- `/o/[slug]/portal/block-time` — member's own read-only summary + history.

## DEFERRED (explicitly out of scope for v1)

1. **Hours-based per-flight discounted-rate drawdown.** v1 tracks "remaining
   prepaid credit" ONLY via the existing derived ledger balance dollar amount —
   NOT a separate hours-remaining meter that decrements per flight. A future
   slice may subtract flown hours from `totalHoursPurchased` directly (would need
   to define how a flight's derived cost maps to hours consumed from a specific
   block, which blocks a member draws from first if they have several, etc.) —
   deliberately punted to keep this slice thin and unambiguous.
2. **Block expiry / refund.** No expiration date, no partial-refund/reversal
   command (a mistaken sale today is corrected via a `credit_memo` ledger entry,
   a forward seam already reserved in the `entry_type` domain — not written by any
   command in this slice).
3. **Family / shared blocks.** One block purchase belongs to exactly one member
   (`block_purchase.user_id`) — no multi-member pooling.
4. **Selling a block through the Stripe rail.** Money-boundary-lift, founder-gated
   — mirrors every other Phase-2 money-crossing decision in this codebase.

## Compliance framing

Operator billing RECORDS, not tax/GAAP/FAA guidance. No airworthiness or currency
determination is made anywhere in this slice. `hours` on a `block_package` /
`block_purchase` is a QUANTITY the operator chooses to sell in bundles — it is
never interpreted as a regulatory currency/recency figure.
