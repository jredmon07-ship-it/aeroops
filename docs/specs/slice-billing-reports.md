> Removed 2026-10-10: money features were removed from AeroOps; kept as a design record.

# Slice — Financial / Accounts-Receivable reporting — build spec

**Turns the billing engine (B0/B1/B2/B3-foundation) into operator-usable financials for the treasurer/accountant
role. READ-ONLY aggregates over EXISTING billing tables (`billing_account`, `ledger_entry`, `invoice`,
`invoice_line_item`) — NO new migration, NO schema change. NO money moved, NO Stripe call, NO write path touched.**

## Scope (3 reads + 1 pure core helper)

1. **AR-aging bucketer** (`packages/core/src/billing/ar-aging.ts`, PURE, property-tested) — buckets one
   `{balanceCents, asOf, referenceDate}` observation into `current | d30 (1-30) | d60 (31-60) | d90 (61-90) |
   d90plus (90+)` by day-age. `aggregateAging(items[])` sums per-item results into org totals. Never throws
   (sanitizes negative/zero/non-integer/NaN/Infinity `balanceCents` to 0; invalid Dates → age 0 → `current`).
2. `getAccountsReceivable(session)` — per-member outstanding balance + org totals, aged into the 5 buckets.
3. `getRevenueReport(session, {range})` — finalized-invoice totals + collected-payment totals over a rolling UTC
   range, with a day/week period breakdown (reuses the FROZEN `reporting/internal.ts` bucketing helpers —
   `resolveReportRange`/`chooseGranularity`/`bucketStartUtc`/`enumerateBuckets`, byte-unchanged).
4. `getMemberStatement(session, {memberId})` — one member's invoices (status + totals, newest-first) + the full
   chronological ledger history with a running balance. STAFF view (`billing:access`) — distinct from the
   member's own portal self-view (`portal:access`, untouched here).

## Metric definitions (pin here — two people must compute the same number)

**AR balance (per member)** = `Σ(debit amount_cents) − Σ(credit amount_cents)` over every `ledger_entry` row for
that member's `billing_account` (the operator-owed direction; the sign is the *inverse* of `computeBalance`'s
"funds available" convention — see `get-accounts-receivable.ts` module doc for the explicit sign-flip note). A
member only appears in the AR list when this is `> 0` (they owe money). A **zero or credit balance is excluded
entirely** — never shown as a $0 or negative AR row.

**Aging reference date** `[VERIFY-AR-AGING-1]` — this system has no per-invoice payment *allocation* (a
`'payment'` credit reduces the whole account, not a specific invoice), so "age of the oldest unpaid invoice" is
approximated per account as: the earliest `'invoice_finalized'` `ledger_entry.created_at` → else the earliest
`'debit'` entry of any type → else the earliest ledger entry of any kind → else `asOf` (`'current'`). This is a
documented approximation, not a claim of true per-invoice aging.

**Revenue — finalized** = `Σ invoice.total_cents WHERE status='finalized' AND issued_at ∈ [bucketStart,bucketEnd)`.
Void invoices excluded (never collectible); drafts excluded (not yet billed).

**Revenue — collected** = `Σ ledger_entry.amount_cents WHERE entry_type='payment' AND direction='credit' AND
created_at ∈ [bucketStart,bucketEnd)`. Every `'payment'` credit, manual or (future) Stripe-webhook-sourced.
Finalized and collected are **independent series** — a payment collected in one bucket may pay down an invoice
finalized in a different bucket; this report does not attempt to match them (no per-invoice allocation exists to
match against).

**Member statement running balance** = `Σ(credit) − Σ(debit)` cumulatively, oldest-first — the LAST row equals the
member's current derived balance (identical to what `getMemberBalance` returns; both derive from the same
append-only `ledger_entry` rows, never a stored/cached balance).

## Invariants (carried from the existing billing/reporting slices)

`org_id` ONLY from session; every aggregate inside one `withSessionOrgContextWithDb`; RLS (ENABLE+FORCE) is the
only org filter on `billing_account`/`ledger_entry`/`invoice`/`app_user` (no redundant `org_id = $input`
predicate — mirrors the documented "subtlest spot" convention in `reporting/get-hours-by-tail.ts` and
`billing/ledger-internal.ts`); read-only (zero writes, zero audit rows — reading a report is not itself a
money-relevant mutation, same posture as `getMemberBalance`); integer cents everywhere, **NEVER a float in the
money path**; raw `sql\`\`` templates bind `from`/`to`/date bounds as ISO strings + `::timestamptz` — **never a
raw JS `Date`** (postgres-js cannot serialize one; PGlite silently can, so tests would not catch the bug).
FROZEN surfaces untouched: `open-dispatch.ts`, every billing WRITE command (`finalize`/`void`/`recordManualPayment`/
`generateInvoiceFromDispatch`) — this slice is a read-only consumer of the ledger, exactly like
`getMemberBalance`/`listLedgerEntries`/`listInvoices` before it.

## Capability choice — `billing:access`, NOT `reporting:access`

`billing:access` → owner / manager / accountant. `reporting:access` is *broader* (also dispatcher, cfi) and is
the right gate for **operational** (non-money) reports (Slice R1). This slice's data is **money** — AR balances,
revenue, and per-member financial history — so it is gated the same as every other billing read
(`getMemberBalance`, `listLedgerEntries`, `listInvoices`, `getInvoice`, `getMemberBillingProfile`):
`billing:access` FIRST, checked inside the `@aeroops/api` function. A dispatcher or CFI (who have
`reporting:access` but not `billing:access`) must never see a member's balance or the org's revenue.

## Web

`/o/[slug]/billing/reports` — AR aging table (sortable-by-column-in-a-follow-up; currently balance-desc, a link
per row into `/o/[slug]/billing/reports/[memberId]`) + a revenue summary (finalized-vs-collected stat pair + a
period-breakdown table; reuses the existing table primitive — **no new chart dependency**) with a `?range=`
selector (30d/90d/180d/365d). `/o/[slug]/billing/reports/[memberId]` — the member statement drill-in (invoices +
chronological ledger + running balance). Reached via a link from the existing `/o/[slug]/billing` hub (no new
top-level nav item — `nav.test.ts` hard-asserts an exact 16-item registry with per-role exact-match arrays across
~15 describe blocks; a Billing sub-page reached by an in-page link, exactly like the existing
`/billing/accounts/[memberId]` account-detail page, is the lower-blast-radius choice and matches established
precedent). Empty state: "No outstanding balances." / "No billing or payment activity in this period." Money
formatted from integer cents via the existing `billing/_components/format-cents.ts` helper (reused, unmodified).

## Compliance framing (light — operational reporting)

This is **OPERATIONAL financial reporting** for an operator's internal use: it derives numbers straight from the
append-only ledger and invoice records already produced by the (compliance-reviewed) B0/B1/B2 billing slices. It
is explicitly **NOT**:
- a tax filing or tax-reporting surface,
- a GAAP/accrual financial statement,
- an audited statement of any kind,
- a Part-141/61 or any FAA-adjacent determination (this slice touches no training/currency/airworthiness data).

No new money movement, no Stripe call, no card/bank data anywhere in this slice — it only *reads* records that
another (already-reviewed) write path produced.

## Deferred (explicitly out of scope for this slice)

- Statement PDF export / emailed statements.
- Dunning / late fees / automated collections workflows.
- Tax reporting (1099s, sales tax, etc.).
- Multi-currency (the entire system is single-currency, USD-cents, today).
- GL export beyond the existing QuickBooks Online invoice export (Slice QB1) — no new GL/export surface here.
- AR-aging column sort / CSV export on the web table (current build is a fixed balance-desc order).
- True per-invoice payment allocation (would change the aging-reference-date approximation from account-level to
  invoice-level — a real product decision, not just an engineering one).

## Validation — hand-computed sample (see `packages/api/src/__tests__/billing-reports.test.ts`)

`aggregateAging` unit test (`packages/core/src/__tests__/ar-aging.test.ts`): 3 items — $100 at age 0 (`current`),
$250 at age 45 (`d60`), $500 at age 120 (`d90plus`) — asserted to bucket exactly to
`{current: 10000, d30: 0, d60: 25000, d90: 0, d90plus: 50000}`, `totalCents: 85000`. The API-level integration
test backdates real `ledger_entry.created_at` rows (via a test-only superuser `RESET ROLE` — `ledger_entry` has
no UPDATE grant for the app role by design; this bypass is test-fixture-only, mirroring the precedent in
`demo-reset.test.ts`) to 0/45/120 days ago and asserts the SAME three-way bucket split end-to-end through
`getAccountsReceivable`, including that a member's balance sums exactly (integer cents, no float) and that a
credit/zero-balance member is excluded from the list entirely.
