#!/usr/bin/env bash
#
# deploy-site.sh — publish the marketing site (site/) to GitHub Pages.
#
#   Live URL: https://jredmon07-ship-it.github.io/aeroops-site/
#
# Publishes the COMMITTED copy of site/ (HEAD), so the local
# localhost:3000 testing override in the working tree never ships.
# The internal site/README.md is excluded, and each page's og:url is
# rewritten to the public Pages host.
#
# USAGE (from the repo root, after committing site changes):
#   bash scripts/deploy-site.sh
#
set -euo pipefail

REPO="jredmon07-ship-it/aeroops-site"
HOST="https://jredmon07-ship-it.github.io/aeroops-site"

cd "$(dirname "$0")/.."
PUB="$(mktemp -d)"
trap 'rm -rf "$PUB"' EXIT

echo "▸ Exporting committed site/ (HEAD)…"
git archive HEAD site/ | tar -x -C "$PUB" --strip-components=1
rm -f "$PUB/README.md"

if grep -ql 'localhost:3000' "$PUB"/*.html 2>/dev/null; then
  echo "ERROR: committed site/ contains localhost:3000 — commit the vercel-URL version first."
  exit 1
fi

echo "▸ Rewriting og:url to $HOST…"
for f in "$PUB"/*.html; do
  page="$(basename "$f")"
  if [[ "$page" == "index.html" ]]; then
    sed -i '' "s#property=\"og:url\" content=\"https://aeroops-web.vercel.app\"#property=\"og:url\" content=\"$HOST/\"#" "$f"
  else
    sed -i '' "s#property=\"og:url\" content=\"https://aeroops-web.vercel.app/$page\"#property=\"og:url\" content=\"$HOST/$page\"#" "$f"
  fi
done

echo "▸ Pushing to $REPO…"
cd "$PUB"
touch .nojekyll
git init -q -b main
git add -A
git -c user.name="Jonathan Redmon" -c user.email="jredmon07@icloud.com" commit -q -m "site deploy $(git -C - log -1 --format=%h 2>/dev/null || echo manual)"
git push -q --force "https://github.com/$REPO.git" main

echo "✅ Pushed. Pages rebuilds in ~1 minute: $HOST/"
