#!/usr/bin/env bash
# Print candidate allowlist lines (path<TAB>line<TAB>TODO) for IS_CLOUD uses that are not yet
# in fork/is-cloud-allowlist.txt. Review each: if it is a feature gate, change the code to
# CLOUD_FEATURES instead; if it is billing/quota/signup/telemetry/cloud-infra, replace TODO with
# that reason and append the line to the allowlist (e.g. `fork/update-allowlist.sh >> fork/is-cloud-allowlist.txt`
# after editing, or paste selectively).
set -euo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"
ALLOWLIST=fork/is-cloud-allowlist.txt
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

find client/src server/src \( -name node_modules -o -name .next \) -prune -o \
  -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' \) \
  ! -name '*.test.*' ! -path '*/__tests__/*' -print | LC_ALL=C sort | while IFS= read -r f; do
  grep -nE '\bIS_CLOUD\b' "$f" 2>/dev/null | sed -E 's/^[0-9]+://' \
    | awk -v f="$f" '{ gsub(/^[ \t]+|[ \t\r]+$/, ""); if ($0 !~ /^import[ {]/ && $0 !~ /^(import )?type / && $0 !~ /^[A-Za-z_]+,?$/) print f "\t" $0 }' || true
done | LC_ALL=C sort -u >"$T/cur"

grep -vE '^[[:space:]]*(#|$)' "$ALLOWLIST" 2>/dev/null | awk -F'\t' '{print $1 "\t" $2}' | LC_ALL=C sort -u >"$T/allow" || : >"$T/allow"
LC_ALL=C comm -23 "$T/cur" "$T/allow" | awk -F'\t' '{printf "%s\t%s\tTODO\n", $1, $2}'
