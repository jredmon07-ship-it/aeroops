# AeroOps marketing site

A four-page marketing site for AeroOps: self-contained static HTML with inline CSS and inline
SVG, one Google Font (Fraunces, with a system-serif fallback so pages still work offline), and
**exactly one `<script>` tag in the whole site** (the inline savings calculator on index.html;
every other page is script-free, and the calculator degrades to placeholder text with JS off).
Copy rule as of 2026-07-14: zero em dashes in rendered copy across all pages. Direction:
**white navy luxury** — a private-FBO-terminal feel, built to the Forma playbook's reference
**"Kirkland & Ellis"** (`DESIGN-REFERENCE-LIBRARY.md`: *"leads with values, not a practice-area
list — crisp monochrome, clean sans, heavy whitespace; premium but purposeful"*) plus the
library's cross-cutting principle **"restraint reads as premium."** Dominantly white/ivory,
deep navy (`#0C1322`, the existing AeroOps brand ink) as the sole anchor color, a display serif
(Fraunces) for headlines set in generous whitespace, hairline navy rules instead of shadows or
color blocks, and system sans/mono for body and data. No amber/gradient accent — the previous
"dispatch console" direction (dark ink + amber signal color, software-console mockups) was
rejected by the founder as reading like a SaaS template; this rebuild replaces it with editorial
restraint: one navy/white palette, a roman-numeral capability list instead of fake UI screenshots.
Copy follows the compliance guardrail: operator-defined rules only, no
FAA-determination claims, no fabricated testimonials, logos, or prices.

## 2026-10-10 — Reframed as an open-source project

The site was reframed as open source on 2026-10-10: pricing, signup CTAs, the cost-comparison
table, and the myFBO migration pitch were removed; the primary CTA is now "View on GitHub"
(https://github.com/jredmon07-ship-it/aeroops), index has an `#open-source` section in place of
`#pricing`, the FAQ covers the MIT license and the public demo, and Privacy/Terms were rewritten as
short pages for an open-source project with a public demo. Billing features are described as using
the operator's own Stripe account. Older notes below describe the earlier commercial site.

## 2026-07-04 — Pricing made scannable + Instructions rewritten and verified against the real app

Two edits, both against the accepted white/navy base (untouched: palette, Fraunces, the
plane-tile logo, the video hero, the no-em-dash / no-competitor-name rules).

**1. Pricing (`index.html#pricing`) — three-second clarity.** The section used to open with
three paragraphs of money-model explanation before the two tiers ever appeared, and the tiers
themselves were stacked in a narrow right-hand column next to that text. Restructured so the
money model is stated in **one plain sentence right under the heading** ("AeroOps never charges
a subscription or a per-aircraft fee. The one fee is small, flat, and capped, and it applies only
when you collect a payment through AeroOps by bank transfer, never on the software itself."),
followed immediately by **Free and Pro side by side**, full width, each with a one-line
"who it's for" (Free: *Flying clubs & small schools*; Pro: *Larger schools & academies*), the
price, and 4 crisp bullets. The longer explanation (card-fee math, the self-collecting invoice
loop, the QuickBooks split, and the "that is a tax on growing your fleet" contrast, still with no
competitor named) now runs *underneath* the tiers as supporting detail, not gating them. Removed
two now-dead CSS rule blocks (`.pricing-inner`, `.price-box`) that the new layout no longer needs.
No new dollar figures invented; the Pro price is still deliberately unnamed ("one flat annual
price"), pending a final pricing decision.

**2. Instructions (`how-it-works.html`) — rewritten from a generic 5-step outline to a verified
setup walkthrough.** The previous version was step-shaped filler ("Set up aircraft and members,"
"Invoices collect themselves") that didn't match any specific screen. Rebuilt as **6 numbered
steps**, each checked against the real product source before being written:

1. **Sign in to your workspace** — `apps/web/app/o/[slug]/login`; lands on the ops dashboard
   (`docs/design/slice-7-dashboard.md`'s "As of now" snapshot + today's flights / grounded /
   open-squawks lists — confirmed real, not invented).
2. **Add your aircraft** *(essential)* — verified against `schedule/resources/_components/
   add-resource-dialog.tsx` (kind + display name + tail number is the actual minimum to create an
   aircraft resource) and `fleet/_components/edit-aircraft-dialog.tsx` (make/model/year/serial/
   home base/Hobbs&tach flags are a separate edit step on the aircraft's Fleet page, not on
   creation — the copy reflects that two-step reality instead of pretending it's one form).
3. **Add your people** *(essential)* — verified against `people/_components/add-member-dialog.tsx`
   (name/email/phone/role) and `settings/import/page.tsx` (the real CSV roster importer, preview
   before commit). Deliberately does **not** call out the competitor name that importer's own
   internal UI copy uses ("Flight Circle") — reworded to "another scheduler" / "a roster export,"
   per the site's no-competitor-name rule, even though the in-app feature itself names it.
4. **Turn on day/night-aware scheduling** *(optional)* — this is the one step that got
   substantively corrected after reading the code. The original brief's step 4 was "set your base
   airport." There is **no self-serve UI to create a location or enter its latitude/longitude**
   anywhere in `apps/web` (confirmed by grep across the app; `location.latitude`/`longitude` are
   only ever set in test fixtures and the demo seed). Rather than invent a "location settings" page
   that doesn't exist, the step was rewritten around the control that *does* exist and *is*
   self-serve: the dispatch board's **Gate settings** dialog (`schedule/board/_components/
   gate-settings-dialog.tsx`), which has a real enabled/warn-or-block toggle for the civil-twilight
   check. Copy is honest that the airport's coordinates are "on file" (set up, not self-entered)
   and carries the mandatory non-FAA-determination disclaimer verbatim from the gate's own
   `[VERIFY-4a-A]` compliance comment.
5. **Schedule and dispatch** *(essential)* — verified against the board's `check-out-dialog.tsx`
   (Hobbs/tach OUT) and `check-in-dialog.tsx` (Hobbs/tach IN + an inline squawk form); added the
   real squawk/grounding consequence ("an aircraft grounded for a squawk cannot be dispatched
   again until the grounding is resolved") that the old copy omitted entirely.
6. **Billing, payments, and QuickBooks** *(optional)* — this is the step that needed the most
   honesty work. `createRateSchedule` and `generateInvoiceFromDispatch` (`packages/api/src/
   billing/`) exist and are tested, but **grep confirms neither is called from any page or server
   action in `apps/web`** — there is no "Rates" screen and no "Generate invoice" button today.
   What *is* real and clickable: `billing/page.tsx` + `billing/[id]/page.tsx` (invoice list/detail,
   Finalize/Void, "Export to QuickBooks"), `billing/accounts/[memberId]` (balance + a manual
   "Record payment" dialog), `portal/billing` (member self-pay, with an honest "not configured"
   state per its own file header when Stripe keys aren't set), and `settings/_components/
   qbo-settings-card.tsx` (the real QuickBooks connect/GL-mapping/export-log card). The copy was
   worded to stay truthful either way: rates are framed as something AeroOps sets up *with* the
   operator (not a self-serve form that doesn't exist yet) while every action named afterward
   (Billing review/finalize/export, Settings → QuickBooks connect) is a real, verified screen.

Every step also got an **Essential** or **Optional** tag (new `.step-tag` chip, monochrome,
matches the hairline/mono system already in use) so a small club can see at a glance that steps
1–2 are the whole requirement and a larger operation can see the full path, per the brief. Hero
copy changed from "Five steps, start to invoice" to lead with that same essential-vs-optional
framing. Cross-link copy on `index.html`'s "Read further" card and its meta/OG tags updated to
match (no longer claims "five steps").

**Verification.** Rendered via headless Chrome (`--headless=new --screenshot`) at 1440px and via
a true 390px iframe harness (fragment-scroll doesn't work in single-shot screenshot mode, so full
pages were captured tall and cropped with Pillow to inspect each section). Confirmed: the Free/Pro
tiers sit side by side at desktop and stack cleanly at 720px and 390px with no overflow; all six
Instructions steps render with legible text, correctly-wrapping Essential/Optional badges, and a
corrected day/night icon (an early crescent-arc SVG rendered as a solid black circle due to
matching sweep-flags on both arcs — fixed to a clean filled-half-circle "Z"-closed path and
re-rendered to confirm). Balanced tag counts confirmed programmatically (`<li>`/`</li>` — excluding
false-positive `<link>` matches — and `<div>`/`</div>` both even in both files). Zero em dashes and
zero competitor names in either file (grepped). No JavaScript added — still zero `<script>` tags
sitewide.

## 2026-07-03 — Rolex-tier evolution: cinematic hero, four pages, navy-hover nav

**This is an evolution, not a rebuild.** The founder asked for the site to move toward
Rolex.com's polish while explicitly keeping the accepted base: the white/
ivory + deep navy palette, the Fraunces serif, and the app-matched plane-tile logo. Nothing in
that base was reworked; it was extended.

### Structure: four files, not anchors-only
Home (`index.html`) keeps the original single-page flow (hero → capabilities → pricing → demo)
and adds a closing "Read further" cross-link strip. **FAQ, Instructions, and Founder became their
own pages** (`faq.html`, `how-it-works.html`, `founder.html`) rather than more anchors on the
home page: each is substantial enough (8 real Q&As, a five-step walkthrough with diagrams, a
personal note) to deserve its own URL, its own `<title>`/meta, and a landing point from search or
a direct share — the same reasoning Rolex itself uses (Collection, Store Locator, and similar
sections are separate pages, not anchors). All four pages share one consistent header/nav/footer,
duplicated per file per the Forma "self-contained, each file its own page" convention. Every nav
item (Home, Platform, Pricing, FAQ, Instructions, Founder) resolves correctly from every page
(subpages link `index.html#product` / `index.html#pricing` for the two anchor sections).

### The cinematic hero
`index.html`'s hero is the exact markup the founder specified: a `<video autoplay muted loop
playsinline preload="auto" poster="hero-poster.jpg"><source src="hero-cessna.mp4" ...></video>`,
full-bleed behind the header, with a navy scrim and the hero copy + primary Demo CTA overlaid.
Both media files are already in `site/` (dropped in during this build) — a golden-hour aerial shot
of a Cessna banking over the ocean, which is why the scrim is tuned asymmetrically (heavy navy
under the text column on the left, sheer enough on the right to let the aircraft and water read
clearly) rather than a flat wash. **Fallback, verified for real, not just in theory:** headless
Chrome's single-shot `--screenshot` mode captures the `poster` frame (not a live video frame), so
every render in this build's screenshot-driven QA *was* the poster-only fallback state — confirmed
it looks fully intentional (crisp headline, legible lede, no dark gradient-less flash). The
`.hero-video-wrap` also carries a CSS navy-gradient background underneath everything, so even
if both media files were absent, the hero still reads as a deliberate dark cinematic panel, not a
blank box. `prefers-reduced-motion: reduce` hides the `<video>` element outright (CSS media query,
no JS), leaving the poster/gradient in place.

### Navy-hover nav, Rolex-style
The nav gained an underline indicator: each link gets a `::after` bar that scales in from the
left on hover/focus/current-page (`transform:scaleX`, matching the plane's need for a "navy," not
Rolex's green). Type went from a plain sans label to small tracked caps (`.76rem`, `.12em`
letter-spacing, uppercase) for a more considered, less "generic SaaS nav" feel. Sticky, frosted
white/blur bar, unchanged in spirit from the base site.

**Mobile nav is native `<details>`/`<summary>` — deliberately zero JavaScript.** The brief allowed
vanilla JS for the mobile toggle, smooth-scroll, and the FAQ accordion, but all three have a
JS-free native-HTML equivalent that's more resilient: `html{scroll-behavior:smooth}` (already in
the base site) covers smooth-scroll, native `<details>` covers the FAQ accordion, and a
`<details class="nav-toggle-wrap">` with the mobile panel as its content covers the hamburger
menu. The hamburger's three bars morph into an X on `[open]` via a pure-CSS transform, no icon
swap needed. Net effect: **the entire site now has zero `<script>` tags**, so "does it work with
JS off" isn't a fallback path to verify — there is no JS path to fall back from.

### Three real bugs this surfaced (all fixed, all re-rendered to confirm)
Screenshot-driven QA is only as good as actually looking, so these are recorded because they
would not have been caught from the source alone:
1. **Hero headline/lede were unreadable.** The CSS for `.hero h1` / `.hero .lede` still targeted
   the *old* section class name (`.hero`) after the section was renamed to `.hero-video-wrap` for
   the video treatment — so the headline silently fell back to the base stylesheet's default
   heading color (navy-on-navy, ~1:1 contrast). Renamed the selectors to `.hero-content h1` /
   `.hero-content .lede` (the still-present wrapper) and confirmed crisp white text on render.
2. **The header's Demo CTA button wrapped into four stacked lines at 390px.** The button stayed
   visible alongside the hamburger below the 980px nav-links breakpoint, with too little room at
   phone widths. Added a `max-width:600px` rule hiding the inline header CTA there — the mobile
   overlay panel already carries its own full-width Demo button, so nothing is lost.
3. **The mobile overlay menu didn't actually cover the page.** `.site-header` carried
   `backdrop-filter` for the frosted-glass look; per spec, `backdrop-filter` (like `transform` and
   `filter`) creates a new *containing block* for descendant `position:fixed` elements — so the
   fixed-position mobile-nav panel, nested inside the header via the `<details>` structure, was
   being sized relative to the 76px-tall header instead of the viewport, collapsing it to a sliver
   instead of a full-screen panel. Fixed by moving the frosted blur onto a separate
   `.site-header-bg` layer that is a **sibling**, not an ancestor, of the nav/`<details>` markup —
   the header itself carries no filter, so `position:fixed` descendants escape to the real
   viewport again. (That in turn needed an explicit `z-index`/`position:relative` on `.site-header
   .wrap` — an absolutely-positioned sibling paints *above* static in-flow content per the CSS
   stacking order regardless of source order, which had briefly ghosted the wordmark and CTA
   button behind the new blur layer until pinned with explicit stacking.)

### New pages' content
- **FAQ** (`faq.html`) — 9 Q&As as native `<details>` (first one open by default to show the
  affordance): really free, how AeroOps makes money, data security (TLS, card data never touches
  AeroOps servers, RLS tenant isolation, point-in-time backups, export anytime), moving off Flight
  Circle (CSV importer), QuickBooks, mobile (iOS in development — not over-promised), the FAA/
  currency disclaimer, who it's for, and setup time.
- **Instructions** (`how-it-works.html`) — five numbered steps (sign in → aircraft & members →
  schedule & dispatch → invoices collect themselves → QuickBooks export), each with a small
  inline-SVG line diagram in the same stroke style as the home page's capability icons (no external
  images, per the brief).
- **Founder** (`founder.html`) — a personal note from Jonathan Redmon (Ohio State student, solo
  builder), stating only the facts supplied: no fabricated bio details, no photo (an honest `JR`
  monogram tile instead of a stock/fake headshot), the free-software-funded-by-fair-payments
  mission stated once (not repeated from the pricing section's $3,000/$87 example, per the
  no-repeated-stats house rule), and a direct `mailto:` contact.

### Forma process followed (this pass)
Read `CLAUDE.md`, `playbook/global-defaults.md`, `COPY-LANGUAGE-CHECKLIST.md`,
`playbook/pre-delivery-checklist.md`, and the luxury/editorial entries in
`DESIGN-REFERENCE-LIBRARY.md` before building. Rolex.com was
supplied directly as the reference (not in the library) — treated as a "like a specific site"
steer on *feel* (cinematic hero, navy-hover nav, restrained page density), rebuilt entirely with
AeroOps's own content, copy, and existing brand system, never lifting layout, text, or assets.

**Three render-and-look rounds, headless Chrome, real Chrome (not a stub), screenshots actually
opened and read:**
1. **Round 1** — full four-page build rendered at 1440. Caught the `.hero`/`.hero-content`
   selector mismatch (headline unreadable) and an unclear step-2 icon reading as a graduation cap
   instead of "aircraft + members."
2. **Round 2** — fixed both; iterated the hero scrim four times against renders until the text
   column was reliably legible without flattening the cinematic reveal of the aircraft. Rendered
   true 390px via an iframe harness (headless Chrome's direct `--window-size` has a documented
   floor below ~400px) and caught the header CTA wrapping bug.
3. **Round 3** — fixed the wrap bug, then interaction-tested the mobile hamburger by forcing the
   `<details open>` state in a scratch copy and screenshotting it (not just assuming the CSS was
   right) — caught the `backdrop-filter` containing-block bug and the resulting white-text-on-
   white-button contrast bug (`.mobile-nav a`'s blanket white color beat the CTA's navy). Fixed
   both, re-rendered the open state to confirm, then re-confirmed all four pages at 1440/820/390
   showed no regressions. Stopped here (3-round cap; nothing outstanding).

## 2026-07-02 edit pass (two changes, not a rebuild)

1. **Brand mark parity.** The founder flagged that the site's mark did not match the product:
   the app shell (`apps/web/.../layout.tsx` header, `bg-brand-ink` command rail) uses a solid
   near-square navy tile (`hsl(222 47% 14%)`, ~2px radius on a 28px tile — "architectural," never
   a circle) with a white bold ✈ (U+2708) glyph centered, plus a hairline shadow. The site's
   hairline-outlined seal (a stroked square + a custom plane path) was a *different* mark, not a
   refinement of the app's — replaced everywhere (header, footer, favicon) with the same tile: a
   `.brand-tile` span carrying the literal ✈ character (guarantees glyph parity with the app,
   which also renders the Unicode glyph rather than a custom path), `border-radius:var(--radius)`
   (the site's existing 3px token — same tight/architectural spirit as the app's 2px), and the
   app's exact navy. On the navy footer, where a navy-on-navy tile would vanish, it inverts to a
   white tile / navy glyph — the same on-navy inversion pattern the file already used for
   `.wordmark`/`.eyebrow`/`.btn-line-inv`, not a new idea. The favicon SVG was recolored to match
   (navy-filled rounded-square, white plane path) since a data-URI favicon can't render a live
   system-font glyph.
2. **Copy realigned to the free-software model.** The business model changed: AeroOps is free
   (no per-aircraft/per-instructor/subscription fee), revenue comes from a flat $5 ACH fee on
   payments processed through the product instead of software licensing. Rewrote the hero
   (leads with "The software is free," states the no-fee list, one line on how — "we make money
   when you get paid, not on the software") and the pricing-philosophy section (the card-fee vs.
   $5-ACH comparison on a $3,000 example, the self-collecting loop from Hobbs reading to
   auto-debit, the QuickBooks rental/instruction account split, cards still welcome) plus the
   meta description/og:description and the price-box "what's included" list, which all
   previously referenced per-aircraft pricing. Re-ran the copy-language checklist against the
   new text after drafting and caught three em dashes introduced in visible body copy (banned by
   this file's own house rule); fixed by splitting sentences or switching to a colon, matching
   the colon style already used in the capability bullet lists (e.g. "Booking policies you
   define: ..."). Verified via two headless-Chrome render rounds (1440 desktop, 390 iframe-harness
   mobile) — not graded from source.

## Deploy

**Order matters:** deploy the site (`scripts/deploy-site.sh`) only after the
`jredmon07-ship-it/aeroops` repo is public (release guide Step 4), and after the app's signup gate
(`ALLOW_SIGNUP` unset) is live on aeroops-web.vercel.app. Every "View on GitHub", issues and license
link on the site points at that repo and returns 404 while it is private.

Four static HTML files plus two media files, no build step. Any of these works:

- Drop the whole `site/` folder on any static host (Vercel, Netlify, Cloudflare Pages, S3, GitHub
  Pages) — `index.html` is the entry point, the other three are linked pages, not includes.
- `npx vercel deploy` from this directory.
- Or open `index.html` directly: double-clicking it works (no build, no server needed). The other
  three pages (`faq.html`, `how-it-works.html`, `founder.html`) also open standalone.

**Required media files (already present in `site/`, not committed by this build):**
`hero-cessna.mp4` (the autoplaying hero background, ~5s loop, 1280x720) and `hero-poster.jpg`
(1376x768 static frame, shown before the video loads and — confirmed by this build's own
screenshot QA — also the effective fallback in any context that can't play the video, e.g.
headless-Chrome single-shot screenshots or an unsupported browser). If either file is ever
removed, the hero still renders as a deliberate dark navy gradient panel (`.hero-video-wrap`'s own
CSS background), never a blank box.

## Forma process followed

Read `CLAUDE.md`, `playbook/global-defaults.md`, `COPY-LANGUAGE-CHECKLIST.md`,
`playbook/pre-delivery-checklist.md`, and `DESIGN-REFERENCE-LIBRARY.md` before building.
Reference direction: **Kirkland & Ellis** (law/advisory monochrome-premium reference), read
against the library's "restraint reads as premium" cross-cutting pattern — chosen because it's
the library's closest match to "white navy luxury" for a B2B operator tool that needs to read
serious and expensive, not consumer/flashy.

**Screenshot-driven iteration (3 rounds, headless Chrome, rendered and LOOKED at — never
graded from code):**
1. **Round 1** — full build, rendered at 1440 / 820 / a plain `--window-size=390` request.
   Desktop and tablet looked clean and premium on first look. The plain-window 390 shot showed
   text and the header CTA clipped on the right edge mid-word — Forma's documented headless-Chrome
   width floor (confirmed by measurement: a 390 request rendered content at a wider internal
   layout and the screenshot cropped rather than scaled). Fixed process, not the page: switched to
   the iframe-harness pattern (a wrapper page with a `width:390px` iframe embedding `index.html`,
   verified pixel-exact at the iframe boundary before trusting the render).
2. **Round 2** — re-rendered true 390px via the harness. Page itself was clean at real 390px;
   found two small nits: the demo credentials `URL` value (`aeroops-web.vercel.app`) was
   breaking mid-word ("vercel.a" / "pp") under `word-break:break-all`, and a leftover unused
   CSS rule (`.eyebrow .num`, never referenced in the markup). Fixed both (`overflow-wrap:
   break-word` breaks cleanly at the hyphen; removed the dead rule) and re-rendered mobile to
   confirm.
3. **Round 3** — full-page re-render at 1440 to confirm no regression from the round-2 CSS
   edits; compared side by side with round 1. Unchanged elsewhere, credentials card now wraps
   cleanly. Stopped here — per an explicit founder efficiency note mid-build ("3 rounds max
   unless something's clearly broken"), and nothing broken remained.

## Forma pre-delivery checklist — verified

- **Render & look (G1):** every section rendered and looked at, at 1440 (desktop), 820
  (tablet), and a true 390px phone viewport via the iframe-harness workaround for headless
  Chrome's window-size floor (verified pixel-exact at the iframe boundary, not assumed).
- **Contrast (AA):** every text/background pair computed numerically (relative-luminance
  formula), not eyeballed — navy `#0C1322` on white 18.55:1; secondary text `#4B5568` on
  white/ivory 7.5:1; white on navy 18.55:1; secondary `#9AA8C2` on navy 7.73:1. All comfortably
  clear AA (4.5:1) for body text.
- **Typography (Gate 2):** a real display/body pairing — Fraunces (serif, optical-size/weight
  axis) for headlines and the wordmark, system sans for body, system mono for data (URL,
  email, credentials) — never Inter/Roboto; one Google Font total, with a Georgia/system-serif
  fallback so the page still reads correctly offline or if the font request fails.
- **Point of view / color (Gates 1, 3):** one named direction (white navy luxury / Kirkland &
  Ellis-referenced restraint), the existing AeroOps navy brand ink as the only anchor color,
  no invented accent hue, no gradients.
- **Hierarchy / mobile (Gates 4, 7):** single-column editorial flow, one primary action per
  section, generous section padding; mobile designed as its own layout (stacked capability
  rows, stacked pricing/demo grids below 820px), not a shrunk desktop.
- **Copy checklist:** scanned visible copy — zero em dashes in visible text (two remain only
  in CSS source comments, never rendered), none of the banned AI-tell vocabulary, no
  rule-of-three padding, no negative parallelism, no staccato-fragment closers (2026-07-02
  house rule), each stat (the $5 ACH cap) stated once, US spelling, one voice. Nothing
  fabricated: no testimonials, no customer logos, no dollar figures for AeroOps itself; demo
  credentials are the real shared-demo ones, labeled as fictional sample data.
- **Invisible (G7/G8 + a11y):** zero JavaScript (verified — no `<script>` tag in the file);
  semantic landmarks (header, nav, main, `aria-labelledby` sections, footer), skip link,
  visible `:focus-visible` outlines (navy on light sections, white on the navy demo/footer
  sections), `prefers-reduced-motion` handled, inline-SVG favicon, real title/meta/OG tags;
  file://-safe by construction (opens by double-click, confirmed no ES-module imports).
- **Brand mark (updated 2026-07-02):** matches the live app shell exactly — a solid near-square
  navy tile (`hsl(222 47% 14%)`, tight/architectural radius, never a circle) with a bold white ✈
  glyph centered, plus a hairline shadow; header ~34px, footer ~28px (the app's literal tile
  size). Inverts to a white tile / navy glyph on the navy footer section so it stays legible
  there, using the file's existing on-navy inversion pattern. The favicon SVG was updated to the
  same navy-tile-plus-white-plane treatment.
- **Compliance guardrail:** no "FAA-compliant" or computed-currency claims anywhere; grounding,
  twilight, and training copy phrased as operator rules; footer states plainly that FAA
  determinations "stay with your operation and your certificated personnel" (the "your rules,
  enforced" framing).

## Not verified (flagged per the playbook)

- **CDP interaction testing:** no puppeteer/playwright available in this environment, so hover
  and focus states were verified from the CSS rules and the rendered screenshots, not a live
  cursor/keyboard session. The transitions used (`background-color`/`color`/`border-color`,
  ~150ms) are the same low-risk pattern as the previously shipped version.
- **Real-device testing:** phone rendering was verified in an emulated, pixel-measured 390px
  viewport (iframe harness), not on hardware.
- **Sub-2s first paint:** near-certain (one ~21 KB HTML file plus one font request) but not
  instrumented.
- **`og:image`:** intentionally absent, same as the prior version — the brief disallows
  external images and OG images cannot be inlined as data URIs in most crawlers' practice.

## 2026-07-03 pass — Forma pre-delivery checklist, re-verified for the four-page site

- **Render & look (G1):** all four pages rendered and looked at, at 1440, 820, and true 390px
  (iframe harness) — three full rounds, documented above, each with real bugs found and fixed
  from the pixels, not assumed from the CSS.
- **Interaction (G2):** the mobile hamburger overlay was interaction-tested, not just styled —
  forced the `<details open>` state in a scratch copy and rendered it, twice (once to catch the
  `backdrop-filter` containing-block bug, once to confirm the fix). The FAQ accordion's open/
  closed states were both rendered (first item ships pre-opened on `faq.html` to show the
  affordance at a glance).
- **Contrast (AA), recomputed for the new surfaces:** navy `#0C1322` on white 18.55:1 (unchanged);
  the hero's white headline/lede sit on a scrim tuned to ≥0.88 alpha navy under the entire text
  column, giving an effective background luminance that clears 4.5:1 against white text even over
  the brightest part of the source photo (the sunset sky) — verified by rendering, not just
  computing, since the real risk here was a moving/bright image bleeding through a naive diagonal
  gradient (round-2 finding, fixed by widening the heavy-scrim zone to actually cover the rendered
  text column's pixel width rather than an eyeballed percentage).
- **Typography (Gate 2):** unchanged system (Fraunces + system sans/mono), extended consistently
  to three new pages; nav links moved to small tracked caps for a more considered nav treatment.
- **Point of view / color (Gates 1, 3):** same navy/white system, no new hue introduced anywhere
  (including the new pages and the hero scrim, which is navy-only, no black or gray substitute).
- **Hierarchy / mobile (Gates 4, 7):** each new page keeps one primary action (Demo CTA, or the
  page's own contextual CTA); mobile nav collapses at 980px to a hamburger (not 760px as before —
  widened because six nav links plus a CTA button needs more room before crowding); the header's
  inline Demo button additionally hides under 600px since the mobile overlay already carries its
  own full-width CTA — verified this doesn't leave the CTA unreachable on any breakpoint (it's
  always present, either inline or inside the overlay).
- **Copy checklist:** re-run against all new prose (FAQ, Instructions, Founder, the rewritten
  hero). Zero em dashes in visible body copy (title tags carry one dash each, matching the base
  site's own pre-existing `<title>` convention, not prose); no banned AI-tell vocabulary; no
  fabricated bio details on the Founder page (only the facts supplied: Ohio State student, solo
  builder, jredmon07@icloud.com); the $3,000/$87 ACH-savings figure appears exactly once (pricing
  section) and is not repeated on the Founder page, which references the fee structure without
  restating the number, per the no-repeated-stats house rule.
- **Invisible (G7/G8 + a11y):** **zero `<script>` tags in any of the four files** — smooth-scroll,
  the mobile menu, and the FAQ accordion are all native HTML/CSS (`scroll-behavior:smooth`,
  `<details>`/`<summary>`), so there is no JS-off fallback state to verify separately; the content
  and every interaction work identically with JavaScript disabled because nothing depends on it.
  Semantic landmarks, skip link, and visible focus rings carried over unchanged; `prefers-reduced-
  motion` now also governs the hero `<video>` (hidden via media query, leaving the poster/gradient).
- **Brand mark:** unchanged, carried onto all three new pages identically (header + footer tiles,
  favicon).
- **Compliance guardrail:** the FAQ's "Do you make FAA or currency determinations?" answer and the
  shared footer fineprint both use the same "stays with your operation and your certificated
  personnel" framing as the rest of the site; no new claims introduced anywhere in the new copy.

### Not verified (flagged per the playbook)
- **Real-device testing:** all mobile verification is emulated (headless Chrome at 390/430px via
  the iframe harness), not on physical hardware.
- **Video playback itself:** headless Chrome's single-shot `--screenshot` mode renders the
  `poster` frame, not a played video frame, so the *fallback* state is what this build's own QA
  actually exercised end to end. The founder should do one live look in a normal browser tab to
  confirm the video plays, loops seamlessly at the 5s mark, and the `prefers-reduced-motion` path
  behaves (Chrome DevTools → Rendering → "Emulate CSS media feature prefers-reduced-motion" is the
  fastest way to check that last one).
- **Lighthouse/real network timing:** not instrumented; the video file is ~10 MB, which is fine
  for a hero background but worth knowing if the founder later cares about first-paint on slow
  connections (the poster shows immediately either way; the video swaps in once buffered).
