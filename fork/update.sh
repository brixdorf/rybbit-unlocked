#!/usr/bin/env bash
# Production updater for self-hosters of THIS fork. Replaces the repo-root update.sh, which does
# `git stash; git pull; docker compose pull` and would drop the unlock patch and replace the
# locally built images with upstream's ghcr.io images.
#
#   fork/update.sh
#   COMPOSE_FILES="docker-compose.lowmem.yml" fork/update.sh     # extra overlay files, space-separated
#
# Why build locally: NEXT_PUBLIC_* values (BACKEND_URL, UNLOCK_CLOUD_FEATURES, ...) are baked
# into the client at image build time, and the patched code is not in upstream's images.
set -euo pipefail

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"

[ -f .env ] || { echo "error: .env not found; run setup.sh first." >&2; exit 1; }
if git remote get-url origin 2>/dev/null | grep -qiE 'github\.com[:/]rybbit-io/rybbit(\.git)?$'; then
  echo "error: origin is upstream rybbit-io/rybbit, not your fork; pulling would drop the unlock patch." >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "WARNING: you have local changes to tracked files. The pull may fail if they overlap with" >&2
  echo "         incoming changes. Commit them on your fork branch (never git stash them away)." >&2
fi

BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"
[ -n "$BRANCH" ] || { echo "error: detached HEAD; check out your fork branch." >&2; exit 1; }
echo "Pulling $BRANCH (fast-forward only)..."
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git pull --ff-only
else
  git pull --ff-only origin "$BRANCH"
fi

COMPOSE=(docker compose -f docker-compose.yml)
for f in ${COMPOSE_FILES:-}; do
  [ -f "$f" ] || { echo "error: compose file not found: $f" >&2; exit 1; }
  COMPOSE+=(-f "$f")
done

if [ -x fork/check-unlock.sh ]; then
  fork/check-unlock.sh || echo "WARNING: check-unlock reported problems (see above); continuing with the update." >&2
fi

echo "Building images locally (do NOT use 'docker compose pull' for backend/client)..."
"${COMPOSE[@]}" build
echo "Starting services..."
"${COMPOSE[@]}" up -d --remove-orphans
docker image prune -f >/dev/null 2>&1 || true
echo "Update complete."
"${COMPOSE[@]}" ps
