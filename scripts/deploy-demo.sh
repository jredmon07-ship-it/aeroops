#!/usr/bin/env bash
#
# deploy-demo.sh — one-command deploy of the current branch to the hosted demo.
#
#   Migrates Neon (0046–0050), wipes + reseeds the demo orgs (Alpha + Bravo with
#   the month of flights + finalized/paid invoices), and pushes to main so Vercel
#   redeploys the app. Stripe is NEVER touched — no step reads a Stripe key.
#
# USAGE (run from the repo root):
#   DATABASE_URL='postgres://neondb_owner:PASSWORD@HOST.neon.tech/neondb?sslmode=require' \
#     bash scripts/deploy-demo.sh
#
#   The URL must be the Neon OWNER/DDL role (not aeroops_app). It stays in your
#   shell — this script never prints or stores it.
#
set -euo pipefail

BRANCH="slice/aerostudy-integration"
cd "$(dirname "$0")/.."

# ── 0. Guard: a real owner connection string must be provided ────────────────
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set."
  echo "  Run: DATABASE_URL='postgres://neondb_owner:PW@HOST.neon.tech/neondb?sslmode=require' bash scripts/deploy-demo.sh"
  exit 1
fi
DB_HOST="$(printf '%s' "$DATABASE_URL" | sed -E 's#.*@([^/?:]+).*#\1#')"
if [[ "$DB_HOST" == "host" || -z "$DB_HOST" ]]; then
  echo "ERROR: DATABASE_URL still looks like the placeholder (host='$DB_HOST')."
  echo "  Paste your real Neon owner connection string."
  exit 1
fi
echo "▸ Target database host: $DB_HOST"
echo "▸ Branch: $BRANCH"
echo

# ── 1. Migrations: dry-run, then apply ───────────────────────────────────────
echo "▸ [1/4] Migration dry-run (applies nothing)…"
pnpm db:migrate
echo
echo "▸ [1/4] Applying migrations to Neon…"
CONFIRM_APPLY=1 pnpm db:migrate:apply
echo

# ── 2. Wipe the old demo orgs so the seed's empty-DB guard passes ────────────
# org_id FKs are ON DELETE CASCADE, so this clears each org's data too.
echo "▸ [2/4] Clearing old demo orgs (alpha, bravo)…"
if command -v psql >/dev/null 2>&1; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DELETE FROM org WHERE slug IN ('alpha','bravo');"
else
  echo "  psql not found — clear them in the Neon SQL console with:"
  echo "    DELETE FROM org WHERE slug IN ('alpha','bravo');"
  echo "  then re-run this script, or continue if the demo DB is already empty."
fi
echo

# ── 3. Reseed both orgs (Alpha + Bravo, full month of activity + billing) ─────
echo "▸ [3/4] Seeding demo data…"
ALLOW_DEMO_SEED=1 pnpm db:seed:demo
echo

# ── 4. Deploy the code (Vercel auto-builds main) ─────────────────────────────
echo "▸ [4/4] Pushing to main (Vercel redeploys)…"
git push origin "${BRANCH}:main"
echo

echo "✅ Done. Once Vercel finishes building:"
echo "   Flying club:  https://<your-app>.vercel.app/o/bravo/login  (owner@bravo.aero / demo1234)"
echo "   Flight school: https://<your-app>.vercel.app/o/alpha/login (owner@alpha.aero / demo1234)"
echo
echo "Note: if login 500s, set AUTH_SECRET in Vercel → Settings → Environment Variables (Production) and redeploy."
