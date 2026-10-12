# Public Booking Launch Readiness — Maintainer Pre-Exposure Checklist

These are the **deploy-only steps** that activate the public booking surface safely.
All the in-app code (CAPTCHA seam, schema, rate guard, honeypot, RLS backstop) is
already built and code-complete. Everything below is **configuration, not code**.

---

## Who this is for

The maintainer / operator before flipping the `/book/[slug]` page live or sharing it
publicly. None of these steps require a code change or redeploy of application code —
they are Vercel env vars + Vercel WAF + a one-time manual purge trigger.

---

## Step A — Edge rate-limiter / WAF on the public submit endpoint

**Why:** The in-app per-org rate guard (10 req/min) is a best-effort soft guard.
The real defense against bot bursts is at the edge, before the app even wakes up.

**What to do (Vercel):**

1. Go to **Vercel Dashboard → your project → Security → Attack Challenge Mode / WAF**.
2. Create a **WAF Rule** (or Rate Limit rule) targeting:
   - Path: `/api/public/booking/*`
   - Method: `POST`
   - Action: **Rate limit** to e.g. 20 req/minute per IP (adjust for your traffic).
   - Consider also enabling **Bot Fight Mode** for this path.
3. Alternative: use a Cloudflare tunnel / Vercel Edge Middleware with `@vercel/edge`
   rate limiting headers. The route is `runtime = 'nodejs'` — the WAF rule fires
   before the function.

**Verification:** Run a burst of 30+ POST requests from a single IP to
`/api/public/booking/your-slug` and confirm Vercel blocks the excess with a 429.

---

## Step B — Activate the CAPTCHA seam

The CAPTCHA seam is code-complete and **INERT by default** (NoopCaptchaVerifier —
always returns true; form renders without a widget). Activation is three env vars.

### B1 — Get a Cloudflare Turnstile account

1. Sign in to [Cloudflare Dashboard](https://dash.cloudflare.com) → Turnstile.
2. Create a new site widget:
   - Type: **Managed** (invisible or visible — your preference).
   - Domain: your Vercel domain (e.g. `aeroops-web.vercel.app`).
3. Copy the **Site Key** (public) and **Secret Key** (private).

### B2 — Set Vercel environment variables

In **Vercel → Project → Settings → Environment Variables**, add:

| Variable | Value | Scope |
|---|---|---|
| `CAPTCHA_PROVIDER` | `turnstile` | Production (and Preview if desired) |
| `CAPTCHA_SECRET_KEY` | `<your Turnstile secret key>` | Production only |
| `NEXT_PUBLIC_CAPTCHA_SITE_KEY` | `<your Turnstile site key>` | Production (and Preview) |

> **Security note:** `CAPTCHA_SECRET_KEY` is server-side only — never expose it.
> `NEXT_PUBLIC_CAPTCHA_SITE_KEY` is intentionally public (bundled into the client;
> all CAPTCHA site keys are public by design).

### B3 — Add the Turnstile script to the public booking page

The CAPTCHA widget JavaScript must be loaded on the `/book/[slug]` page. Add it to
`apps/web/app/book/[slug]/layout.tsx` (create if absent) or `page.tsx`:

```tsx
import Script from 'next/script';

// Inside the layout/page return:
<Script
  src="https://challenges.cloudflare.com/turnstile/v0/api.js"
  strategy="lazyOnload"
/>
```

Or add it to the `<head>` via `apps/web/app/book/[slug]/page.tsx` metadata.

> This is the **only code change** needed to fully activate CAPTCHA. Once the env
> vars are set AND this script is loaded, the `book-request-form.tsx` widget container
> renders automatically (it checks `NEXT_PUBLIC_CAPTCHA_SITE_KEY` at runtime) and
> the token is included in every submit.

### B4 — Redeploy

After setting the env vars and the script tag, trigger a Vercel redeploy.
The seam activates automatically — no other code change.

### B5 — Verification

1. Visit `/book/your-slug` — you should see the Turnstile widget before the submit button.
2. Submit the form as a real user — the request should succeed (widget generates a valid token).
3. Disable JavaScript and submit — the CAPTCHA check will fail (token absent → false →
   silent-drop `{ ok:true }` — no insert). This is the intended bot-blocker behavior.

---

## Step C — Activate booking-request retention / purge (PB-LR.A)

Lead PII (name, email, phone) in `booking_request` is retained indefinitely until
an operator manually purges it (or a scheduled job does). Configure the window.

### C1 — Set a retention window per org

In the AeroOps UI: **Settings → Booking request retention** (owner/manager only):
- Set `retentionDays` (1–3650; 0 = keep forever).
- Toggle `includesConverted` (default off — converted requests are NOT purged).

The default is 365 days for new orgs.

### C2 — Run a dry-run purge first

From the UI: click **"Purge now"** → the UI shows the dry-run count
("X requests would be deleted") before asking for confirmation.

Or from the CLI (owner DATABASE_URL):
```bash
pnpm db:purge:booking
```
This prints a count per org and exits WITHOUT deleting (dry-run default).

### C3 — Apply the purge

From the UI: confirm the dialog after reviewing the dry-run count.

Or from the CLI:
```bash
CONFIRM_APPLY=1 pnpm db:purge:booking:apply
```

> **Safety note:** the purge is per-org, RLS-scoped, and audited
> (`booking_request.purged` audit row with counts only — no PII in the audit log).
> `retentionDays=0` is a no-op (never deletes all). Hard-DELETE (not anonymize).
> [VERIFY-PB1-COMP-1]: confirm hard-delete vs anonymize posture with your compliance
> officer before enabling for real customer data.

### C4 — Automate (optional)

To run purges on a schedule, create a GitHub Actions workflow or a Vercel Cron Job
that calls the CLI script (`pnpm db:purge:booking:apply`) with the appropriate
`DATABASE_URL` and `CONFIRM_APPLY=1`. The script purges each org under its own
`withOrgContext` — never a cross-org DELETE.

---

## Step D — Verify a bot burst is throttled

After completing steps A–B:

1. Use a tool like `hey`, `wrk`, or `curl` in a loop to send 50+ POST requests
   to `/api/public/booking/your-slug` within a few seconds.
2. Confirm:
   - Early requests (within WAF limit) succeed with `{ ok: true }`.
   - Requests over the WAF limit get a 429 (before hitting the app).
   - Requests with a bad/missing CAPTCHA token get `{ ok: true }` (silent-drop —
     no row inserted; check the DB to confirm zero new rows).
3. Confirm the in-app rate guard is a backstop: even if the WAF is bypassed, the
   11th+ request within 1 minute from the same org returns `{ ok: true }` with no
   new row (check the `booking_request` table to confirm).

---

## Summary

| Step | What it is | Needed before public? |
|---|---|---|
| A — WAF/edge rate limit | Vercel config | Yes — do this FIRST |
| B — CAPTCHA env vars + script tag | Vercel env vars + 1 code line | Strongly recommended |
| C — Retention config + purge | Vercel/UI config | Required for GDPR/privacy posture |
| D — Burst verification | Manual QA | Before launch |

The **in-app code is complete** (rate guard, honeypot, CAPTCHA seam, RLS backstop,
retention config, purge script). No further code changes are needed for launch.
