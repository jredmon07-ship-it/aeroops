> Removed 2026-10-10: money features were removed from AeroOps; kept as a design record.

# Slice P2 — POS / Counter Sales

**Status:** BUILD-COMPLETE (awaiting human review). Branch `slice/code-health-rows-helper`. Migration `0031_pos_sales.sql` staged + human-gated, NOT applied.

## Summary

Sell non-flight items (headsets, charts, fuel, merch) via a "counter sale" that
rides the EXISTING B1 invoice/invoice_line_item write path + the EXISTING B2
ledger + P0 payments — a counter sale is just a draft invoice whose lines are
catalog/ad-hoc items instead of dispatch-derived ones. NO Stripe Terminal, NO
inventory decrement, NO tax lines, NO barcode — all deferred to P3.

## [DECISION-1] — memberId is REQUIRED, not optional

`invoice.member_user_id` is `NOT NULL` with a composite FK to `app_user`
(frozen B1 table, migration 0019). The B2 ledger debit and P0 autopay both key
off that member. A true walk-in with no account cannot own an invoice without
a schema change to a frozen table. **`createCounterSale` requires `memberId`**
(an existing app_user in the org). "Walk-in / no-account" is a DEFERRED
forward seam. The web surface labels the picker "Bill to member" (required).

## Data model

New table `product_catalog` (migration `0031_pos_sales.sql`):

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| org_id | uuid NOT NULL | tenant spine, RLS ENABLE+FORCE |
| name | text NOT NULL | CHECK nonempty |
| unit_price_cents | integer NOT NULL | CHECK > 0 — integer cents only |
| sku | text | nullable free-text |
| category | text | nullable free-text |
| active | boolean NOT NULL DEFAULT true | soft-retire flag |
| created_by | uuid NOT NULL | composite FK → app_user(id, org_id) RESTRICT |
| created_at / updated_at | timestamptz | |

Composite FKs (hand-written, mirrors `rate_schedule`/`document` precedent):
`(org_id) → org(id) CASCADE`; `(created_by, org_id) → app_user(id, org_id) RESTRICT`.
`UNIQUE(id, org_id)`. Standard 4-policy RLS (byte-identical NULLIF predicate
copied from migration 0030). Index `(org_id, active, name)`.

**No FK from `invoice_line_item` back to `product_catalog`** — a sale's lines
SNAPSHOT the catalog item's name + price at sale time (exactly like
`generate-invoice.ts` snapshots a `rate_schedule`'s amount), so a later price
change or a hard-delete of the catalog item never retroactively alters a
historical sale. This is why `deleteProductCatalogItem` can safely hard-delete.

Drizzle schema: `packages/db/src/schema/product-catalog.ts`, registered in
`packages/db/src/schema/index.ts`.

## Pure core math

`packages/core/src/billing/invoice-math.ts` adds
`computeCounterSaleLineTotal(quantity, unitPriceCents)`:

- `quantity` must be a **positive integer**; `unitPriceCents` a **non-negative
  integer** (both finite) — else throws `RangeError`.
- Returns `quantity * unitPriceCents` — an **exact integer product, no
  rounding, no float step** (unlike `applyRate`, which rounds a fractional
  hours × cents product).
- Totals are summed with the existing `computeInvoiceTotals` (exact integer
  sum).

Exported from `packages/core/src/index.ts`. Property-tested (P-CS-1..3) in
`packages/core/src/__tests__/invoice-math.test.ts`.

## API

House pattern throughout: `requireCapability` FIRST → zod `safeParse` →
`withSessionOrgContextWithDb` → audit via `audit_log` → `*WithDb` core + thin
prod wrapper. NO new capabilities — reuses `billing:manage` (writes) and
`billing:access` (reads), both already owned by owner/manager
(accountant read-only).

### Catalog CRUD — `packages/api/src/billing/product-catalog-commands.ts`

- `createProductCatalogItem` / `…WithDb` — `billing:manage`. Trims name/sku/
  category; empty-string sku/category → `null`. Audits
  `billing.product_catalog_item_created`.
- `updateProductCatalogItem` / `…WithDb` — `billing:manage`. Partial update
  (name/unitPriceCents/sku/category/active); `not_found` if absent. Price
  changes do NOT retroactively alter past sales (line items snapshot the
  amount at sale time). Audits `billing.product_catalog_item_updated`.
- `listProductCatalogItems` / `…WithDb` — `billing:access`. Default
  active-only; `includeInactive` option. Ordered by name.
- `deleteProductCatalogItem` / `…WithDb` — `billing:manage`. Hard delete is
  safe (no FK from `invoice_line_item`). Audits
  `billing.product_catalog_item_deleted`.

### Shared draft-invoice writer — `packages/api/src/billing/invoice-write-internal.ts`

`insertDraftInvoiceWithLinesTx(tx, sess, params)` — a tx-inner helper that
INSERTs one draft `invoice` + N `invoice_line_item` rows, byte-shape identical
to what `generate-invoice.ts` produces (status `'draft'`, `issuedAt: null`,
totals via `computeInvoiceTotals`). Satisfies "NO bespoke invoice INSERT" —
`createCounterSale` reuses this instead of writing its own INSERT.
**`generate-invoice.ts` / `generate-dues-invoices.ts` are NOT refactored to
adopt it in this slice** — they stay byte-stable to protect the existing test
baseline; adopting them is an optional future cleanup.

### `createCounterSale` / `createCounterSaleWithDb` — `packages/api/src/billing/counter-sale.ts` — `billing:manage`

Input: `{ memberId: uuid, lines: Array<{catalogItemId, quantity} | {name, unitPriceCents, quantity}> }`
(min 1 line; zod union per line — `catalogItemId` present ⇒ catalog line,
name/price ignored; else ad-hoc line requires name + price).

Flow: resolve member (RLS-scoped select; absent → `member_not_found`) →
resolve + price each catalog line (absent → `catalog_item_not_found`;
`active=false` → `catalog_item_inactive`; snapshot name+price) → build line
specs with `computeCounterSaleLineTotal` → `insertDraftInvoiceWithLinesTx` →
ONE audit row `billing.counter_sale_created` → return
`{ ok:true, invoice: InvoiceView & { lineItems } }`.

**Finalization is NOT part of this command.** The web surface calls the
EXISTING, unchanged `finalizeInvoice` (`billing:manage`) as a second, explicit
step — draft→finalized + the B2 ledger debit + P0 autopay identically for a
counter-sale invoice. No new finalize/ledger/autopay code in this slice.

Barrel-exported from `packages/api/src/index.ts` (both calling forms +
`ProductCatalogView`, `CreateCounterSaleResult`, `ListProductCatalogItemsOptions`, etc).

## Web

Boundary rule: pages/actions import ONLY from `@aeroops/api`, never
`@aeroops/db`; dates serialized to ISO at the action boundary; amounts
formatted via the existing `billing/_components/format-cents.ts`.

- `apps/web/app/o/[slug]/(shell)/billing/pos/actions.ts` — server actions for
  catalog CRUD, `listBillableMembersAction` (wraps `listMembers`,
  `people:access` — see note below), `createCounterSaleAction`,
  `finalizeCounterSaleAction` (thin wrapper over `finalizeInvoice`).
- `apps/web/app/o/[slug]/(shell)/billing/catalog/page.tsx` +
  `_components/catalog-client.tsx` — catalog admin. States: loading /
  empty ("No catalog items yet" + "Add item" CTA) / populated (table +
  edit/deactivate/delete, gated to `billing:manage`) / error / permission-denied.
- `apps/web/app/o/[slug]/(shell)/billing/pos/page.tsx` +
  `_components/pos-client.tsx` — counter sale surface. Member picker
  ("Bill to member", required) + catalog-item picker + ad-hoc line form +
  running subtotal + "Create sale" / "Create & finalize". States: loading /
  populated / empty (no lines yet) / error / permission-denied (billing:manage
  absent → explanatory message, no create controls rendered).

**Cap-ordering note:** `listMembers` (used for the "Bill to member" picker)
requires `people:access`. Every role with `billing:manage` (owner/manager)
also has `people:access` (see `packages/core/src/capabilities.ts`), so
`pos/page.tsx` only fetches members/catalog and renders the create form when
the session has `billing:manage` — an accountant (`billing:access` only, no
`people:access`) never triggers a `Forbidden` from `listMembers`.

**Nav deviation from the raw brief:** "Catalog" and "Counter sale" are reached
from links inside the existing Billing surface rather than as new top-level
`NAV_ITEMS` registry entries. `apps/web/lib/nav.ts`'s `NAV_ITEMS` +
`apps/web/lib/__tests__/nav.test.ts` pin an exact-count, exact-order contract
across all 8 roles (15 items today); adding two more entries would require
rewriting a large, deliberately rigid test file for a net-new UX pattern.
This mirrors the EXISTING precedent that `billing/accounts/[memberId]` (the
per-member ledger detail) also has no separate top-level nav item — it's a
sub-surface of Billing, reached from within it. Discoverability is preserved
(both pages are one click from `/o/[slug]/billing`); the underlying
`requireCapability('billing:access')` gate on both pages is unaffected by nav
presentation. If a top-level nav entry is later wanted, that's a `nav.ts` +
`nav.test.ts` follow-up, not part of this slice.

## Compliance (verbatim, load-bearing)

> COMPLIANCE (records posture): `product_catalog` is an operator-defined price
> list of non-flight goods and services (headsets, charts, fuel, merchandise).
> `unit_price_cents` and every counter-sale amount are INTEGER CENTS — never
> floats. A counter sale is an operator billing RECORD: it creates a draft
> invoice via the existing B1 invoice write path and moves NO money by itself
> — money moves only if the invoice is later finalized and charged through the
> existing, unchanged P0 Stripe/autopay path (PCI SAQ-A; NO raw card/bank data
> is ever stored). This slice computes NO tax and makes NO tax determination —
> `category` and `sku` are FREE-TEXT operator labels, not tax classes;
> sales-tax handling, inventory-on-hand, and card-present (Stripe Terminal)
> capture are DEFERRED (P3). No FAA/airworthiness determination is involved.
> [VERIFY-P2-A]: sales-tax collection/remittance posture is out of scope here
> and must be resolved by compliance before tax lines ship.

Web POS surface shows an inline note: "Amounts are recorded in cents. Creating
a sale drafts an invoice; no card is charged until you finalize it. Tax is not
calculated."

## Tests

- `packages/core/src/__tests__/invoice-math.test.ts` — P-CS-1..3 property
  tests for `computeCounterSaleLineTotal` (non-negative integer / repeated
  addition; no-float-drift across many randomized lines with
  `computeInvoiceTotals`; throws on invalid inputs).
- `packages/api/src/__tests__/pos-counter-sale.test.ts` — PGlite + fakes, no
  real HTTP; migrations 0000–0031; `seedTwoOrgs`; `FakeStripeClient`:
  - Catalog CRUD + caps + audit rows + T-ISO (org B cannot list/update/
    delete org A items).
  - `createCounterSale`: correct-total draft invoice via the real path
    (catalog-only, mixed catalog+ad-hoc); inactive/unknown catalog item;
    unknown member; empty lines / bad quantity → `ValidationError`;
    price-change immutability after a sale; caps; T-ISO (cross-org ids →
    `member_not_found` / `catalog_item_not_found`, no enumeration).
  - Finalize parity: counter-sale draft → `finalizeInvoice` → `finalized` +
    exactly ONE `invoice_finalized` debit `ledger_entry`; re-finalize blocked;
    concurrent double-finalize posts at most one debit; with a saved PM +
    autopay enabled, finalize triggers autopay identically to a dispatch
    invoice (asserted via `FakeStripeClient` PI amount + idempotency key).
  - Deleting a catalog item used in a past sale leaves the sale intact.
  - Regression smoke: a 20-line sale totals exactly Σ(quantity × price).

**Regression guards:** `git diff` on `packages/api/src/dispatch/open-dispatch.ts`,
`close-dispatch.ts`, and `gatedCreateOccurrence` stays empty (untouched by this
slice). `generate-invoice.ts` / `generate-dues-invoices.ts` / `invoice-status-commands.ts`
are unchanged. Full suite green above the pre-slice baseline; no new
capabilities added.

## Deferred (out of scope for this slice)

- Walk-in / no-account sales ([DECISION-1]).
- Sales tax lines ([VERIFY-P2-A]).
- Inventory-on-hand decrement.
- Barcode/scanner entry.
- Stripe Terminal card-present capture.
- Per-org SKU uniqueness constraint.
- Catalog categories as a managed taxonomy.
- A top-level `NAV_ITEMS` entry for Catalog/Counter sale (see nav deviation
  note above).

## File manifest

New:
- `packages/db/migrations/0031_pos_sales.sql` / `.down.sql`
- `packages/db/src/schema/product-catalog.ts`
- `packages/api/src/billing/product-catalog-commands.ts`
- `packages/api/src/billing/invoice-write-internal.ts`
- `packages/api/src/billing/counter-sale.ts`
- `packages/api/src/__tests__/pos-counter-sale.test.ts`
- `apps/web/app/o/[slug]/(shell)/billing/pos/page.tsx`
- `apps/web/app/o/[slug]/(shell)/billing/pos/actions.ts`
- `apps/web/app/o/[slug]/(shell)/billing/pos/_components/pos-client.tsx`
- `apps/web/app/o/[slug]/(shell)/billing/catalog/page.tsx`
- `apps/web/app/o/[slug]/(shell)/billing/catalog/_components/catalog-client.tsx`
- `docs/specs/slice-p2-pos.md` (this file)

Edited:
- `packages/db/src/schema/index.ts` (register `productCatalog`)
- `packages/core/src/billing/invoice-math.ts` (+`computeCounterSaleLineTotal`)
- `packages/core/src/index.ts` (export it)
- `packages/core/src/__tests__/invoice-math.test.ts` (P-CS-* property tests)
- `packages/api/src/index.ts` (barrel-export new commands + types)

**Untouched (byte-identical):** `packages/api/src/dispatch/open-dispatch.ts`,
`close-dispatch.ts`, `gatedCreateOccurrence`, `billing/generate-invoice.ts`,
`billing/generate-dues-invoices.ts`, `billing/invoice-status-commands.ts`,
`apps/web/lib/nav.ts`.

**Open [VERIFY] for compliance-officer:** [VERIFY-P2-A] sales-tax
collection/remittance posture (blocking before any tax-line follow-up; not
blocking this slice).
