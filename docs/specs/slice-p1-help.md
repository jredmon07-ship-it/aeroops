> Note 2026-10-10: money features were removed from AeroOps; the Billing & payments and QuickBooks help categories and their articles no longer exist.

# Slice P1.8 — Help / knowledge base

**Status:** BUILD-COMPLETE. Branch `slice/code-health-rows-helper`. Frontend-only —
no schema, no migration, no new backend/API surface. Maintainer direction: "keep
building"; this is the self-serve support layer referenced in
`docs/ROADMAP.md` P1.8 ("Help docs / knowledge base ... self-serve
support is what lets support scale solo").

## Why

AeroOps is free software supported by one person. A self-serve help center is
the thing that lets that scale — an operator with a question about how
dispatch, invoicing, or QuickBooks export works should find the answer without
opening a support channel.

## Scope (built)

- **A Help hub** at `/o/[slug]/help`, gated on `app:access` (the broadest
  capability — every one of the 8 roles has it, so Help is visible to
  everyone). A categorized index across 9 categories: Getting started,
  Scheduling & dispatch, Maintenance, Training records, Billing & payments,
  QuickBooks, People & fleet, The mobile app, Account & data.
- **Individual article pages** at `/o/[slug]/help/[article]` — one article per
  slug, rendered from a typed in-file data array (`apps/web/lib/help-articles.ts`),
  not one-off page components. Adding an article is a data edit: a `{ slug,
  title, category, summary, body }` entry, where `body` is a tiny tagged union
  (`p` / `ul` / `note`) rendered generically by the article page.
- **32 articles** across the 9 categories, each describing a feature that is
  **actually shipped**, written from its build spec in `docs/specs/*.md` (see
  the content rule below). Compliance framing (grounding, squawks,
  maintenance-due, training progress, lesson signatures, civil twilight) is
  carried through lightly — one short callout block per article, not a wall of
  legal text — matching the same "operator data, not an FAA determination"
  posture used throughout the app.
- **Client-side search/filter** (`help/_components/help-search.tsx`) — a
  controlled input that filters the article list by title/summary substring
  match as you type. Progressive enhancement: the full categorized index is
  present in the server-rendered HTML regardless; the filter only narrows what's
  visible. Announces the result count via an `aria-live` region; a dedicated
  "No articles match" empty state when a search matches nothing.
- **New "Help" nav item** (`apps/web/lib/nav.ts`) — `app:access`, placed
  **last** in `NAV_ITEMS` (after Org settings) since it's a support/reference
  surface, not an operational one. `apps/web/lib/__tests__/nav.test.ts` updated:
  every role's `EXPECTED_LABELS` gets `+1` ("Help" appended), `NAV_ITEMS.length`
  15 → 16, the "last item" registry assertion moved from Org settings to Help
  (Org settings is now second-to-last), plus a new describe block (17) asserting
  Help is visible to all 8 roles and always the last item in every role's
  filtered nav.
- **`apps/web/lib/help-articles.ts`** — pure data module (zero DOM/Next.js
  imports, mirrors `lib/nav.ts`'s framework-agnostic style) exporting
  `HELP_CATEGORIES`, `HELP_ARTICLES`, and three pure helpers
  (`getArticleBySlug`, `articlesInCategory`, `searchHelpArticles`), plus a
  sanity test suite (`apps/web/lib/__tests__/help-articles.test.ts`) that
  guards the data's structural integrity: unique slugs, every article's
  category exists, non-empty title/summary/body, every category has ≥1
  article. It intentionally does not re-litigate the prose — content accuracy
  against `docs/specs/*.md` was verified by hand while writing each article.

## Content rule (load-bearing)

Every article was written by reading the real build spec for the feature it
documents (dispatch, grounding/squawks, work orders, maintenance-due,
training/lesson-signatures, invoicing/ledger/autopay/dues/POS/logbook,
QuickBooks export, people/fleet/documents, mobile, notifications/activity/
portal/reports/booking). Nothing here is invented or aspirational. Where the
underlying feature carries a compliance disclaimer in its own spec (e.g.
"grounding is operator data, not a Part 91/43 determination"), the article
repeats that framing in a single short `note` block.

## States

- **Populated** — the categorized index (hub) / one article (detail page).
  Content is 100% static and synchronous — there is no true "empty" state on
  the hub itself (the article list is never empty) and no server call that can
  fail, so **loading** and **error** states are not applicable here.
- **Empty** — an unknown/removed article slug renders a "we couldn't find that
  article" panel with a link back to the hub; a search query matching zero
  articles renders a "No articles match" panel inside the search component.
- **Permission-denied** — both pages check `hasCapability(session, 'app:access')`
  and render a tasteful "not available" panel (no redirect), mirroring the
  activity/reports pattern. In practice this branch is unreachable for any real
  session — `app:access` is granted to all 8 roles — so it is defense-in-depth,
  not a role split.

## Accessibility

Real `<h1>`/`<h2>` heading hierarchy (page title → category → article), a
`<label>` associated with the search input, `aria-live="polite"` result-count
announcements, semantic `<ul>`/`<li>` lists, and `focus-visible` rings on every
link consistent with the rest of the app.

## Guardrails held

Frontend-only: no new DB table/migration, no new server action beyond the
existing `auth()`/`hasCapability` read used by every other shell page. No
change to `packages/api`'s barrel, auth/token code, the dispatch gates, the
mobile API routes, weather, or billing internals. Real gate is
`hasCapability`/the shell's own `auth()` check — hiding the nav link is
cosmetic, same as every other nav item.

## Deferred (explicitly out of scope)

- In-app contextual tooltips / inline help (e.g. a "?" icon next to a specific
  field linking to the relevant article).
- Video walkthroughs.
- An AI support chat / assistant over the knowledge base.
- A public, unauthenticated marketing help site (today's Help hub is
  inside the authenticated app shell only, `app:access`-gated).
