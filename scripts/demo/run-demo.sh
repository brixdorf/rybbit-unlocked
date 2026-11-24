#!/usr/bin/env bash
# End-to-end before/after demo: stock upstream vs this fork, on the same generated data.
# See scripts/demo/README.md ("Full before/after demo"). No prompts; Ctrl-C stops what it started.
#
#   scripts/demo/run-demo.sh            # schema must already exist
#   scripts/demo/run-demo.sh --migrate  # also initialise the (disposable) demo database schema
#
# Env (all optional):
#   STOCK_DIR=/home/user/rybbit-stock   FORK_DIR=<repo root>   OUT_DIR=<FORK_DIR>/scripts/demo/screenshots
#   ENV_FILE=<server env file to source>  BASE_URL=http://localhost:8080  BACKEND_PORT=3001  CLIENT_PORT=3002
#   DEMO_EMAIL DEMO_PASSWORD DEMO_DOMAIN  VISITORS=800  DAYS=30  LIVE_MIN=2
#   WORK_DIR=/tmp/rybbit-demo (logs, pids, state)   SKIP_GENERATE=1 (reuse data already generated)
#   PG_CONTAINER=postgres  CH_CONTAINER=clickhouse  PROXY_CONTAINER=devproxy
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK_DIR="${FORK_DIR:-$(cd "$HERE/../.." && pwd)}"
STOCK_DIR="${STOCK_DIR:-$FORK_DIR/../rybbit-stock}"
OUT_DIR="${OUT_DIR:-$FORK_DIR/scripts/demo/screenshots}"
ENV_FILE="${ENV_FILE:-$HERE/demo.env}"
if [ ! -f "$ENV_FILE" ] && [ "$ENV_FILE" = "$HERE/demo.env" ]; then
  sed "s/^BETTER_AUTH_SECRET=__GENERATE__/BETTER_AUTH_SECRET=$(openssl rand -hex 32)/" "$HERE/demo.env.example" > "$ENV_FILE"
fi
BASE_URL="${BASE_URL:-http://localhost:8080}"
BACKEND_PORT="${BACKEND_PORT:-3001}"
CLIENT_PORT="${CLIENT_PORT:-3002}"
WORK_DIR="${WORK_DIR:-/tmp/rybbit-demo}"
VISITORS="${VISITORS:-800}"
DAYS="${DAYS:-30}"
LIVE_MIN="${LIVE_MIN:-2}"
PG_CONTAINER="${PG_CONTAINER:-postgres}"
CH_CONTAINER="${CH_CONTAINER:-clickhouse}"
PROXY_CONTAINER="${PROXY_CONTAINER:-devproxy}"
export DEMO_EMAIL="${DEMO_EMAIL:-demo@lumenly.example}"
export DEMO_PASSWORD="${DEMO_PASSWORD:-Demo-Pass-12345!}"
export DEMO_DOMAIN="${DEMO_DOMAIN:-demo-shop.example}"
export BASE_URL

DO_MIGRATE=0
for a in "$@"; do
  case "$a" in
    --migrate) DO_MIGRATE=1 ;;
    -h|--help) sed -n 2,16p "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

mkdir -p "$WORK_DIR" "$OUT_DIR"
STATE_FILE="$WORK_DIR/state.json"; export STATE_FILE
PIDS=()

log()   { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
info()  { printf '   %s\n' "$*"; }
die()   { printf '\n\033[1;31mABORT: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- cleanup
stop_servers() {
  local p
  for p in "${PIDS[@]:-}"; do
    [ -n "$p" ] || continue
    # each server was started with setsid, so its pid is its process-group id
    kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true
  done
  for p in "${PIDS[@]:-}"; do
    [ -n "$p" ] || continue
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$p" 2>/dev/null || true
  done
  PIDS=()
}
trap 'stop_servers' EXIT
trap 'echo; echo "interrupted"; exit 130' INT TERM

wait_http() { # url, max seconds, label
  local url="$1" max="$2" label="$3" i=0
  while [ $i -lt "$max" ]; do
    if curl -fsS -o /dev/null --max-time 3 "$url" 2>/dev/null; then info "$label is up ($url)"; return 0; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

psql_q() { docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:-frog}" "$PG_CONTAINER" psql -U "${POSTGRES_USER:-frog}" -d "${POSTGRES_DB:-analytics}" -tAc "$1" 2>/dev/null; }

start_stack() { # label, tree
  local label="$1" tree="$2"
  log "Start $label backend + client ($tree)"
  port_busy "$BACKEND_PORT" && die "port $BACKEND_PORT is already in use; stop whatever listens there first"
  port_busy "$CLIENT_PORT"  && die "port $CLIENT_PORT is already in use; stop whatever listens there first"
  (
    cd "$tree/server" && set -a && . "$ENV_FILE" && set +a
    exec setsid node dist/index.js >"$WORK_DIR/$label-backend.log" 2>&1
  ) &
  PIDS+=("$!")
  (
    cd "$tree/client"
    exec setsid ./node_modules/.bin/next start -p "$CLIENT_PORT" >"$WORK_DIR/$label-client.log" 2>&1
  ) &
  PIDS+=("$!")
  info "logs: $WORK_DIR/$label-backend.log, $WORK_DIR/$label-client.log"
  wait_http "http://localhost:$BACKEND_PORT/api/health" 90 "$label backend /api/health" \
    || die "$label backend did not become healthy; see $WORK_DIR/$label-backend.log"
  wait_http "http://localhost:$CLIENT_PORT/login" 90 "$label client /login" \
    || die "$label client did not serve /login; see $WORK_DIR/$label-client.log"
  wait_http "$BASE_URL/login" 20 "proxy -> client" || die "$BASE_URL/login is not reachable through the proxy"
  wait_http "$BASE_URL/api/health" 20 "proxy -> backend" || die "$BASE_URL/api/health is not reachable through the proxy"
}

# ---------------------------------------------------------------- a. preflight
log "a. Preflight"
for c in "$PG_CONTAINER" "$CH_CONTAINER" redis "$PROXY_CONTAINER"; do
  st="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null)" \
    || die "container '$c' not found"
  case "$st" in
    "running healthy"|"running ") info "container $c: $st" ;;
    *) die "container $c is not running/healthy: $st" ;;
  esac
done
[ -f "$ENV_FILE" ] || die "server env file not found: $ENV_FILE (set ENV_FILE)"
set -a; . "$ENV_FILE"; set +a
for tool in node curl docker; do command -v "$tool" >/dev/null || die "missing tool: $tool"; done
[ -f "$STOCK_DIR/server/dist/index.js" ] || die "stock server build missing: $STOCK_DIR/server/dist/index.js"
[ -d "$STOCK_DIR/client/.next" ]        || die "stock client build missing: $STOCK_DIR/client/.next"
[ -d "$FORK_DIR/client/.next" ]         || die "fork client build missing: $FORK_DIR/client/.next"
if [ ! -f "$FORK_DIR/server/dist/index.js" ] || [ -n "$(find "$FORK_DIR/server/src" "$FORK_DIR/shared" -path '*/node_modules' -prune -o -type f -newer "$FORK_DIR/server/dist/index.js" -print -quit 2>/dev/null)" ]; then
  info "fork server build is missing or older than its sources: running 'pnpm build' in server/ (tsc)"
  (cd "$FORK_DIR/server" && pnpm build) >"$WORK_DIR/fork-server-build.log" 2>&1 \
    || die "fork server build failed; see $WORK_DIR/fork-server-build.log"
fi
info "builds present: stock server+client, fork server+client"
if port_busy "$BACKEND_PORT" || port_busy "$CLIENT_PORT"; then die "ports $BACKEND_PORT/$CLIENT_PORT must be free"; fi
curl -fsS -o /dev/null --max-time 5 -X GET "http://localhost:8123/ping" || die "ClickHouse HTTP port 8123 not answering"

# ---------------------------------------------------------------- b. schema
log "b. Schema"
if [ "$DO_MIGRATE" = 1 ]; then
  info "NOTE: --migrate initialises the disposable DEMO database (Postgres schema via drizzle-kit migrate)."
  info "      Only use it on the throwaway demo database. Server tables are created by the app on startup (ClickHouse)."
  (cd "$FORK_DIR/server" && ./node_modules/.bin/drizzle-kit migrate --config=drizzle.config.ts) \
    || die "drizzle-kit migrate failed"
else
  info "no --migrate flag: not touching the schema, only verifying it exists"
fi
if [ "$(psql_q "select to_regclass('public.\"user\"') is not null")" != "t" ]; then
  die "Postgres schema not found (no table \"user\" in database '${POSTGRES_DB:-analytics}').
       The demo does not create it on its own. Re-run with --migrate once the owner has approved
       initialising the demo database."
fi
info "table \"user\" exists: schema OK"

# ---------------------------------------------------------------- c. stock stack
start_stack stock "$STOCK_DIR"

# ---------------------------------------------------------------- d. bootstrap + data
log "d. Bootstrap account, organization, site, API key"
BOOT="$(node "$HERE/bootstrap.mjs")" || die "bootstrap failed (see messages above)"
echo "$BOOT" >"$STATE_FILE"
SITE_ID="$(node -e 'console.log(JSON.parse(process.argv[1]).siteId)' "$BOOT")"
API_KEY="$(node -e 'console.log(JSON.parse(process.argv[1]).apiKey)' "$BOOT")"
info "siteId=$SITE_ID domain=$DEMO_DOMAIN (credentials: $DEMO_EMAIL, password from DEMO_PASSWORD)"
export SITE_ID

GEN_LOG="$WORK_DIR/generator.log"
if [ "${SKIP_GENERATE:-0}" = 1 ] && [ -s "$GEN_LOG" ]; then
  info "SKIP_GENERATE=1: re-using data from the previous run (log: $GEN_LOG)"
else
  log "d2. Generate traffic ($VISITORS visitors, $DAYS days, setup, live ${LIVE_MIN} min) -- this takes a few minutes"
  node "$HERE/generate-traffic.mjs" --base-url "http://localhost:$BACKEND_PORT" --site-id "$SITE_ID" \
    --api-key "$API_KEY" --visitors "$VISITORS" --days "$DAYS" --setup --live "$LIVE_MIN" 2>&1 | tee "$GEN_LOG"
  [ "${PIPESTATUS[0]}" = 0 ] || die "traffic generator failed; see $GEN_LOG"
fi
info "waiting for ClickHouse ingestion to settle"; sleep 5

# ---------------------------------------------------------------- e. BEFORE
log "e. BEFORE screenshots (stock UI)"
rm -f "$OUT_DIR"/before-*.png "$OUT_DIR"/manifest-before.json
node "$HERE/screenshots.mjs" --phase before --site-id "$SITE_ID" --out "$OUT_DIR" \
  || info "screenshots (before) reported a fatal error; continuing with what was captured"

# ---------------------------------------------------------------- f. AFTER
log "f. Switch to the fork"
stop_servers
sleep 2
start_stack fork "$FORK_DIR"   # restart also promotes the first user to admin (initPostgres)
log "f2. AFTER screenshots (fork UI, same data)"
rm -f "$OUT_DIR"/after-*.png "$OUT_DIR"/manifest-after.json
node "$HERE/screenshots.mjs" --phase after --site-id "$SITE_ID" --out "$OUT_DIR" \
  || info "screenshots (after) reported a fatal error; continuing with what was captured"

# ---------------------------------------------------------------- g. report
log "g. Report"
node "$HERE/make-report.mjs" "$OUT_DIR" "$GEN_LOG"

# ---------------------------------------------------------------- h. cleanup
log "h. Cleanup"
stop_servers
info "servers stopped; containers left running"
info "screenshots + REPORT.md: $OUT_DIR"
