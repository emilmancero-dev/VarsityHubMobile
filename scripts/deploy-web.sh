#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Gated, auto-following PRODUCTION web deploy for varsityhub.app.
#
# This is the CANONICAL way to ship the web app. Prefer it over a raw
# `vercel --prod`, which has two footguns that already caused a prod outage:
#
#   1. `vercel --prod` does NOT move the varsityhub.app / www.varsityhub.app
#      custom-domain aliases onto the new deployment — the site silently keeps
#      serving the previous build until the aliases are repointed by hand.
#   2. A plain local `expo export` bakes LOCAL env, which is missing prod-only
#      EXPO_PUBLIC_* values (e.g. EXPO_PUBLIC_WEB_BASE_URL=https://varsityhub.app),
#      shipping a subtly-wrong bundle.
#
# What this wrapper does:
#   1. GATE   — client typecheck + secret-literal scan (block on failure).
#   2. ENV    — pull production EXPO_PUBLIC_* from Vercel so the export is correct.
#   3. DEPLOY — scripts/deploy-web-static.sh (deterministic prebuilt upload: it
#               strips ignoreCommand so the build can't be skipped, and it
#               re-aliases BOTH custom domains onto the new deployment = auto-follow).
#   4. SMOKE  — hit the live domain; if it's broken, auto-roll-back the aliases
#               to the deployment that was live before this run.
#
# Usage:   npm run deploy:web
# Env:
#   SKIP_GATE=1            emergency: skip typecheck/secret gate (prints a warning)
#   VERCEL_SCOPE=<slug>    vercel scope/team (default: linked .vercel/project.json)
#   VERCEL_TOKEN=<token>   for non-interactive / CI auth
#   VERCEL_CUSTOM_DOMAINS  space-separated (default "www.varsityhub.app varsityhub.app")
# ─────────────────────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

read -ra DOMAINS <<< "${VERCEL_CUSTOM_DOMAINS:-www.varsityhub.app varsityhub.app}"
PRIMARY_DOMAIN="${DOMAINS[0]}"

VC_ARGS=()
[[ -n "${VERCEL_TOKEN:-}" ]] && VC_ARGS+=(--token "$VERCEL_TOKEN")
[[ -n "${VERCEL_SCOPE:-}" ]] && VC_ARGS+=(--scope "$VERCEL_SCOPE")

log()  { printf '\n\033[1;36m[deploy-web]\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31m[deploy-web] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v npx  >/dev/null 2>&1 || fail "npx not found."
command -v curl >/dev/null 2>&1 || fail "curl not found."
[[ -f .vercel/project.json ]] || fail "Missing .vercel/project.json — run 'npx vercel link' first."

# ── 1. GATE ──────────────────────────────────────────────────────────────────
if [[ "${SKIP_GATE:-0}" == "1" ]]; then
  log "⚠️  SKIP_GATE=1 — bypassing typecheck + secret gate (EMERGENCY hotfix mode)."
else
  log "Gate 1/2: client TypeScript (tsc --noEmit)…"
  npx tsc --noEmit || fail "TypeScript errors — fix them, or re-run with SKIP_GATE=1 for an emergency hotfix."
  log "Gate 2/2: secret-literal scan…"
  npm run verify:secrets || fail "Secret scan failed — a secret literal may be about to ship."
  log "Gate passed."
fi

# ── 2. Load PRODUCTION EXPO_PUBLIC_* so the export bakes correct values ───────
log "Pulling production env from Vercel…"
npx vercel pull --yes --environment=production ${VC_ARGS[@]+"${VC_ARGS[@]}"} >/dev/null 2>&1 \
  || fail "vercel pull failed — check your Vercel auth/scope."
if [[ -f .vercel/.env.production.local ]]; then
  log "Loading production EXPO_PUBLIC_* into the build environment…"
  while IFS= read -r line; do
    key="${line%%=*}"; val="${line#*=}"
    val="${val%\"}"; val="${val#\"}"      # strip surrounding quotes
    export "$key=$val"
  done < <(grep -E '^EXPO_PUBLIC_[A-Za-z0-9_]+=' .vercel/.env.production.local)
fi

# ── 3. Record the currently-live deployment as a rollback target ─────────────
log "Recording current live deployment (rollback target)…"
# NOTE: `vercel inspect` prints deployment details to STDERR, so capture 2>&1.
PREV_URL="$(npx vercel inspect "$PRIMARY_DOMAIN" ${VC_ARGS[@]+"${VC_ARGS[@]}"} 2>&1 \
  | grep -oE 'https://[a-z0-9-]+\.vercel\.app' | head -1 || true)"
if [[ -n "$PREV_URL" ]]; then log "Rollback target: $PREV_URL"; else log "No rollback target found (first clean deploy?)."; fi

# ── 4. Deterministic prebuilt deploy + auto-follow re-alias ──────────────────
log "Building + deploying (deterministic prebuilt path, auto-follows both domains)…"
bash scripts/deploy-web-static.sh "${VERCEL_SCOPE:-}"

# ── 5. Smoke-test the live site; auto-roll-back on failure ───────────────────
log "Smoke-testing https://$PRIMARY_DOMAIN …"
sleep 3
UA="Mozilla/5.0 (deploy-web smoke)"
root_code=$(curl   -sS -A "$UA" -o /dev/null -w '%{http_code}' "https://$PRIMARY_DOMAIN/?cb=$RANDOM"            || echo 000)
detail_code=$(curl -sS -A "$UA" -o /dev/null -w '%{http_code}' "https://$PRIMARY_DOMAIN/public-event?cb=$RANDOM" || echo 000)
redir_code=$(curl  -sS -A "$UA" -o /dev/null -w '%{http_code}' "https://$PRIMARY_DOMAIN/events/smoke-$RANDOM"    || echo 000)
log "root=$root_code  /public-event=$detail_code  /events/:id=$redir_code   (expect 200 / 200 / 307)"

ok=1
[[ "$root_code"   == "200" ]] || ok=0
[[ "$detail_code" == "200" ]] || ok=0
[[ "$redir_code"  == "307" || "$redir_code" == "308" ]] || ok=0

if [[ "$ok" != "1" ]]; then
  if [[ -n "$PREV_URL" ]]; then
    log "❌ Smoke FAILED — rolling aliases back to $PREV_URL"
    for d in "${DOMAINS[@]}"; do npx vercel alias set "$PREV_URL" "$d" ${VC_ARGS[@]+"${VC_ARGS[@]}"} || true; done
    fail "Deploy smoke-tested BAD; rolled the custom domains back to the previous deployment."
  fi
  fail "Deploy smoke-tested BAD and no rollback target was available — investigate immediately."
fi

log "✅ Production web deploy healthy and live at https://$PRIMARY_DOMAIN"
