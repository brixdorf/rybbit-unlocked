#!/usr/bin/env bash
# Verify the cloud-features unlock patch after an upstream merge.
#
#   fork/check-unlock.sh [--since REF] [--typecheck] [--record]
#
#   (a) patch intact: CLOUD_FEATURES definitions + build/deploy wiring + usage count
#   (b) every IS_CLOUD use in client/src and server/src is in fork/is-cloud-allowlist.txt
#   (c) informational: new DB migrations / ClickHouse schema files since the last sync
#   (d) --typecheck: shared build + client and server typecheck
#   --record: rewrite fork/expected-unlock-count.txt from the current tree (do this on purpose,
#             after reviewing, when the patch legitimately grew or shrank)
#
# Exit 0 = OK (warnings allowed). Exit 1 = patch broken, unreviewed IS_CLOUD use, or typecheck failure.
set -euo pipefail

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"
ALLOWLIST=fork/is-cloud-allowlist.txt
COUNTFILE=fork/expected-unlock-count.txt

SINCE="" TYPECHECK=0 RECORD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="${2:?--since needs a ref}"; shift 2 ;;
    --typecheck) TYPECHECK=1; shift ;;
    --record) RECORD=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

FAIL=0
ok()   { printf '  ok    %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; FAIL=1; }
need() { # need <file> <regex> <description>
  if [ -f "$1" ] && grep -qE "$2" "$1"; then ok "$3"; else bad "$3  (expected /$2/ in $1)"; fi
}

# Non-test source files of both apps.
src_files() {
  find client/src server/src \( -name node_modules -o -name .next \) -prune -o \
    -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' \) \
    ! -name '*.test.*' ! -path '*/__tests__/*' -print | LC_ALL=C sort
}

# path<TAB>trimmed line for every line mentioning word $1 (import lines excluded).
uses() {
  src_files | while IFS= read -r f; do
    grep -nE "\\b$1\\b" "$f" 2>/dev/null | sed -E 's/^[0-9]+://' \
      | awk -v f="$f" '{ gsub(/^[ \t]+|[ \t\r]+$/, ""); if ($0 !~ /^import[ {]/ && $0 !~ /^(import )?type / && $0 !~ /^[A-Za-z_]+,?$/) print f "\t" $0 }' || true
  done
}

echo "== (a) patch integrity =="
need server/src/lib/const.ts   '^export const UNLOCK_CLOUD_FEATURES' "server UNLOCK_CLOUD_FEATURES defined"
need server/src/lib/const.ts   '^export const CLOUD_FEATURES'        "server CLOUD_FEATURES defined"
need client/src/lib/const.ts   '^export const UNLOCK_CLOUD_FEATURES' "client UNLOCK_CLOUD_FEATURES defined"
need client/src/lib/const.ts   '^export const CLOUD_FEATURES'        "client CLOUD_FEATURES defined"
need client/next.config.ts     'NEXT_PUBLIC_UNLOCK_CLOUD_FEATURES'  "next.config.ts exposes NEXT_PUBLIC_UNLOCK_CLOUD_FEATURES"
need client/Dockerfile         '^ARG NEXT_PUBLIC_UNLOCK_CLOUD_FEATURES' "client/Dockerfile ARG"
need client/Dockerfile         '^ENV NEXT_PUBLIC_UNLOCK_CLOUD_FEATURES' "client/Dockerfile ENV"
need docker-compose.yml        '^ +- UNLOCK_CLOUD_FEATURES='         "docker-compose.yml backend env"
need docker-compose.yml        '^ +NEXT_PUBLIC_UNLOCK_CLOUD_FEATURES:' "docker-compose.yml client build arg"
need docker-compose.yml        '^ +- NEXT_PUBLIC_UNLOCK_CLOUD_FEATURES=' "docker-compose.yml client env"
need .env.example              '^UNLOCK_CLOUD_FEATURES='             ".env.example documents the flag"

# CLOUD_FEATURES gate usages (definition files and imports excluded).
USAGE=$(uses CLOUD_FEATURES | grep -vE '^(client|server)/src/lib/const\.ts	' | wc -l | tr -d ' ')
if [ "$RECORD" = 1 ]; then
  printf '%s\n' "$USAGE" >"$COUNTFILE"
  echo "  recorded: $COUNTFILE = $USAGE"
elif [ -f "$COUNTFILE" ]; then
  EXPECTED=$(tr -d ' \n' <"$COUNTFILE")
  if [ "$USAGE" -ge "$EXPECTED" ]; then ok "CLOUD_FEATURES gate lines: $USAGE (minimum $EXPECTED)"
  else bad "CLOUD_FEATURES gate lines dropped to $USAGE, expected >= $EXPECTED: a merge probably overwrote gates (git diff HEAD^1 -- client/src server/src | grep CLOUD_FEATURES)"; fi
else
  warn "$COUNTFILE missing: run fork/check-unlock.sh --record once to create it (current count: $USAGE)"
fi

echo
echo "== (b) IS_CLOUD review =="
if [ ! -f "$ALLOWLIST" ]; then
  bad "$ALLOWLIST missing"
else
  T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
  uses IS_CLOUD | LC_ALL=C sort -u >"$T/cur"
  grep -vE '^[[:space:]]*(#|$)' "$ALLOWLIST" | awk -F'\t' '{print $1 "\t" $2}' | LC_ALL=C sort -u >"$T/allow"
  LC_ALL=C comm -23 "$T/cur" "$T/allow" >"$T/new"
  LC_ALL=C comm -13 "$T/cur" "$T/allow" >"$T/stale"
  if [ -s "$T/new" ]; then
    bad "$(wc -l <"$T/new" | tr -d ' ') NEW unreviewed IS_CLOUD use(s). Decide per use: feature that only needs its own runtime deps -> switch to CLOUD_FEATURES; billing/quota/telemetry/signup -> keep and add to the allowlist (fork/update-allowlist.sh prints candidate lines):"
    awk -F'\t' '{printf "          %s\n            %s\n", $1, $2}' "$T/new"
  else
    ok "all $(wc -l <"$T/cur" | tr -d ' ') distinct IS_CLOUD lines are allowlisted"
  fi
  if [ -s "$T/stale" ]; then
    warn "$(wc -l <"$T/stale" | tr -d ' ') stale allowlist entr(ies) (code changed/removed upstream); prune or refresh them:"
    awk -F'\t' '{printf "          %s\n            %s\n", $1, $2}' "$T/stale"
  fi
fi

echo
echo "== (c) schema changes since last sync (informational) =="
if [ -z "$SINCE" ]; then
  if git log -1 --format=%s HEAD | grep -q '^chore(upstream): merge'; then SINCE="HEAD^1"
  else
    L=$(git log --first-parent -1 --format=%H --grep='^chore(upstream): merge' HEAD || true)
    [ -n "$L" ] && SINCE="$L^1"
  fi
fi
if [ -z "$SINCE" ]; then
  echo "  no previous 'chore(upstream): merge' commit found; pass --since <ref> (e.g. the commit before the merge)"
elif ! git rev-parse -q --verify "$SINCE^{commit}" >/dev/null; then
  warn "unknown ref for --since: $SINCE"
else
  echo "  comparing $(git rev-parse --short "$SINCE") .. HEAD"
  CH=$(git diff --name-status "$SINCE" HEAD -- server/drizzle server/src/db clickhouse docker-compose.yml 2>/dev/null | grep -vE '\.test\.' || true)
  if [ -z "$CH" ]; then echo "  none"
  else
    echo "$CH" | sed 's/^/    /'
    if echo "$CH" | grep -q 'server/drizzle/'; then
      echo "  -> new Postgres migrations: the backend applies them at start; take a backup first (pg_dump) on production."
    fi
  fi
fi

if [ "$TYPECHECK" = 1 ]; then
  echo
  echo "== (d) typecheck =="
  if pnpm --filter @rybbit/shared build && pnpm --filter client typecheck && pnpm --filter rybbit-backend typecheck; then
    ok "shared build + client + server typecheck"
  else
    bad "typecheck failed"
  fi
fi

echo
if [ "$FAIL" = 0 ]; then echo "RESULT: OK"; else echo "RESULT: FAILED (see FAIL lines above; guidance in UNLOCK.md and fork/README.md)"; fi
exit "$FAIL"
