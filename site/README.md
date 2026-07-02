# AeroOps marketing site

A single-file, one-page marketing site for AeroOps (`index.html`), built to the Forma
playbook: self-contained static HTML with inline CSS and inline SVG, no JavaScript, no
external images, one Google Font (Space Grotesk, with a system-stack fallback so the page
still works offline). Design direction: a "dispatch console" editorial — ink navy + warm
paper + one signal-amber accent, mono type for operational labels, and an inline-SVG
dispatch board as the hero visual. Copy follows the compliance guardrail: operator-defined
rules only, no FAA-determination claims, no fabricated testimonials, logos, or prices.

## Deploy

It is one file. Any of these works:

- Drop `index.html` on any static host (Vercel, Netlify, Cloudflare Pages, S3, GitHub Pages).
- `npx vercel deploy` from this directory.
- Or open it directly: double-clicking `index.html` works (no build, no server needed).

## Forma pre-delivery checklist — verified

- **Rendered and looked (G1):** full page screenshotted with headless Chrome at 1440px
  (desktop), 820px (tablet), and a true 390px phone viewport (via an iframe harness, since
  headless Chrome enforces a 500px minimum window). All text visible, legible, un-clipped;
  no horizontal overflow at any width; instrumented DOM sweep confirmed zero elements
  outside the viewport.
- **Contrast (AA):** every text/background pair computed numerically; all visible-copy pairs
  are 4.56:1 or better (most exceed 7:1). SVG board labels were lightened to 6.07:1 after
  the first pass measured 2.98:1.
- **Copy checklist:** scanned visible copy — zero em dashes, none of the banned AI-tell
  vocabulary, no rule-of-three padding, no negative parallelism, US spelling, one voice.
  Nothing fabricated: no testimonials, no customer logos, no dollar figures; demo
  credentials are the real shared-demo ones and are labeled as fictional sample data.
- **Invisible (G7/G8 + a11y):** no-JS backbone is trivially total (the page ships zero
  JavaScript); semantic landmarks (header, nav, main, labeled sections, footer), skip link,
  visible focus rings, `prefers-reduced-motion` handled, favicon (inline data URI), real
  title/meta/OG tags; file://-safe by construction.
- **Mobile (Gate 7):** designed single-column; the dispatch-board SVG becomes a keyboard-
  focusable horizontal-scroll region below 720px instead of shrinking illegibly.
- **Compliance guardrail:** no "FAA-compliant" or computed-currency claims anywhere;
  twilight, grounding, and training copy phrased as operator rules; footer carries an
  explicit no-FAA-determinations disclaimer.

## Not verified (flagged per the playbook)

- **CDP interaction testing:** there is no JS mechanic, custom cursor, or scroll hijack to
  drive; hover/focus states were verified from CSS plus spot renders, not a live CDP session.
- **Real-device testing:** phone rendering was verified in an emulated 390px viewport, not
  on hardware.
- **Sub-2s first paint:** near-certain (one ~35 KB HTML file plus one font request) but not
  instrumented.
- **`og:image`:** intentionally absent; the brief disallowed external images and OG images
  cannot be inlined. Add a hosted 1200×630 PNG if link-preview cards matter.
