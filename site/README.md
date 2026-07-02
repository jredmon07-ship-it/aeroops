# AeroOps marketing site

A single-file, one-page marketing site for AeroOps (`index.html`): self-contained static
HTML with inline CSS and inline SVG, no JavaScript, no external images, one Google Font
(Fraunces, with a system-serif fallback so the page still works offline). Direction: **white
navy luxury** — a private-FBO-terminal feel, built to the Forma playbook's reference
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
FAA-determination claims, no fabricated testimonials, logos, or prices. Per a founder directive
mid-build, the page was kept deliberately short: hero, four capability areas, pricing
philosophy, live-demo access, footer — no extra "also in the box" grid or feature-visual
cards, to keep the whitespace-first feel intact.

**2026-07-02 edit pass (two changes, not a rebuild):**
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

It is one file. Any of these works:

- Drop `index.html` on any static host (Vercel, Netlify, Cloudflare Pages, S3, GitHub Pages).
- `npx vercel deploy` from this directory.
- Or open it directly: double-clicking `index.html` works (no build, no server needed).

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
