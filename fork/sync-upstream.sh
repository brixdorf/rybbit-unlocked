#!/usr/bin/env bash
# Merge an upstream Rybbit release (or master) into a fresh sync/<target> branch.
#
#   fork/sync-upstream.sh [--master] [--no-fetch] [--dry-run] [--allow-side-branch] [TARGET]
#
#   TARGET      upstream tag (v2.10.0), upstream/master, or any ref. Default: the highest upstream
#               vX.Y.Z tag that is not yet merged and is newer than the current merge base with
#               upstream/master. --master is shorthand for upstream/master.
#   --no-fetch  skip network (use refs already fetched)
#   --dry-run   print the resolved target/branch and stop
#   --allow-side-branch  permit a tag that is not on upstream/master (patch releases such as
#               v2.9.3 live on side branches; their fixes normally also land on master, and merging
#               the tag itself tends to conflict. Prefer --master or the next minor tag.)
#
# Safety: requires a clean tracked tree, never force-pushes, never pushes at all, never touches
# the branch you started from (it creates sync/<target> from it). Re-running is harmless:
# an already-merged target is a no-op. On conflicts it stops and lists them; see UNLOCK.md and
# fork/README.md. After a clean merge it runs fork/check-unlock.sh.
set -euo pipefail

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/rybbit-io/rybbit.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-master}"

TARGET="" MASTER=0 FETCH=1 DRY=0 SIDE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --master) MASTER=1; shift ;;
    --no-fetch) FETCH=0; shift ;;
    --dry-run) DRY=1; shift ;;
    --allow-side-branch) SIDE=1; shift ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) [ -z "$TARGET" ] || { echo "only one target allowed" >&2; exit 2; }; TARGET="$1"; shift ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }

# --- preconditions -----------------------------------------------------------------------
git rev-parse --verify -q HEAD >/dev/null || die "repository has no commits"
[ ! -f "$(git rev-parse --git-path MERGE_HEAD)" ] || die "a merge is already in progress. Resolve it (git add ...; git commit --no-edit) or git merge --abort, then re-run."
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "working tree has uncommitted changes to tracked files; commit or stash them first."
START_BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"
[ -n "$START_BRANCH" ] || die "HEAD is detached; check out your fork branch first."

# --- remote, rerere, fetch -----------------------------------------------------------------
if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "adding remote upstream -> $UPSTREAM_URL"
  git remote add upstream "$UPSTREAM_URL"
fi
git config rerere.enabled true   # remember conflict resolutions across syncs

if [ "$FETCH" = 1 ]; then
  if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
    echo "repository is shallow; fetching full upstream history (one-time, can take a minute)..."
    git fetch --unshallow --tags upstream
  fi
  git fetch --tags --prune upstream
fi
git rev-parse --verify -q "upstream/$UPSTREAM_BRANCH^{commit}" >/dev/null \
  || die "upstream/$UPSTREAM_BRANCH not found (run without --no-fetch)"
[ "$(git rev-parse --is-shallow-repository)" = false ] || echo "warning: repository is still shallow; merge-base detection may be wrong." >&2

# --- target ----------------------------------------------------------------------------------
if [ "$MASTER" = 1 ]; then
  [ -z "$TARGET" ] || die "--master and an explicit TARGET are mutually exclusive"
  TARGET="upstream/$UPSTREAM_BRANCH"
fi
if [ -z "$TARGET" ]; then
  MB="$(git merge-base HEAD "upstream/$UPSTREAM_BRANCH")" || die "no merge base with upstream/$UPSTREAM_BRANCH (still shallow?)"
  MB_DATE="$(git log -1 --format=%ct "$MB")"
  echo "merge base with upstream/$UPSTREAM_BRANCH: $(git log -1 --format='%h %cs %s' "$MB")"
  for t in $(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$'); do
    git merge-base --is-ancestor "$t^{commit}" HEAD && continue          # already merged
    git merge-base --is-ancestor "$t^{commit}" "upstream/$UPSTREAM_BRANCH" || continue   # patch release on a side branch
    [ "$(git log -1 --format=%ct "$t^{commit}")" -gt "$MB_DATE" ] || continue   # older than what we have
    TARGET="$t"; break
  done
  if [ -z "$TARGET" ]; then
    echo "No upstream release tag newer than the merge base. Use --master to sync upstream/$UPSTREAM_BRANCH, or pass a tag."
    exit 0
  fi
  echo "latest unmerged upstream tag: $TARGET"
fi
TARGET_SHA="$(git rev-parse --verify -q "$TARGET^{commit}")" || die "unknown ref: $TARGET"

if git merge-base --is-ancestor "$TARGET_SHA" HEAD; then
  echo "Already up to date: $TARGET ($(git rev-parse --short "$TARGET_SHA")) is already contained in $START_BRANCH."
  exit 0
fi

if [ "$SIDE" = 0 ] && ! git merge-base --is-ancestor "$TARGET_SHA" "upstream/$UPSTREAM_BRANCH"; then
  die "$TARGET is not on upstream/$UPSTREAM_BRANCH (a patch release cut from a side branch). Its fixes are normally also on master, and merging the tag directly tends to conflict. Use --master or a minor tag; pass --allow-side-branch to override."
fi

SAFE="${TARGET#upstream/}"; SAFE="${SAFE//[^A-Za-z0-9._-]/-}"
[ "$TARGET" != "upstream/$UPSTREAM_BRANCH" ] || SAFE="$UPSTREAM_BRANCH-$(git rev-parse --short "$TARGET_SHA")"
BRANCH="sync/$SAFE"
echo "target : $TARGET ($(git rev-parse --short "$TARGET_SHA"))"
echo "branch : $BRANCH (from $START_BRANCH @ $(git rev-parse --short HEAD))"
echo "commits to merge: $(git rev-list --count HEAD.."$TARGET_SHA")"
[ "$DRY" = 0 ] || exit 0

if [ "$START_BRANCH" = "$BRANCH" ]; then
  echo "already on $BRANCH; merging in place"
elif git show-ref --verify -q "refs/heads/$BRANCH"; then
  if git merge-base --is-ancestor "$TARGET_SHA" "$BRANCH"; then
    echo "Branch $BRANCH already contains $TARGET. Nothing to do (git switch $BRANCH to continue)."; exit 0
  fi
  die "branch $BRANCH exists but does not contain $TARGET. git switch $BRANCH and re-run, or delete it (git branch -D $BRANCH)."
else
  git switch -c "$BRANCH"
fi
PRE="$(git rev-parse HEAD)"

# --- merge -------------------------------------------------------------------------------------
set +e
git merge --no-ff -m "chore(upstream): merge $TARGET" "$TARGET_SHA"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  CONFLICTS="$(git diff --name-only --diff-filter=U)"
  echo
  if [ -z "$CONFLICTS" ]; then
    echo "merge failed without conflicts (see git output above). Back out with: git merge --abort; git switch $START_BRANCH; git branch -D $BRANCH" >&2
    exit 1
  fi
  echo "MERGE CONFLICTS in:"
  echo "$CONFLICTS" | sed 's/^/  /'
  cat <<MSG

Resolve them on branch $BRANCH:
  * Our patch is small: for each gate keep upstream's new code and swap IS_CLOUD -> CLOUD_FEATURES
    where the feature only needs its own runtime dependencies. UNLOCK.md lists the patched files
    and the rule; fork/README.md has per-file hints (Sidebar.tsx, TrackingTab.tsx, docker-compose.yml,
    client/Dockerfile, server/src/lib/const.ts, server/src/index.ts).
  * git rerere is on, so repeated conflicts get replayed automatically next time.
  * Then:  git add <files> && git commit --no-edit
           fork/check-unlock.sh --since $(git rev-parse --short "$PRE") --typecheck
  * Give up:  git merge --abort; git switch $START_BRANCH; git branch -D $BRANCH
Nothing was pushed. $START_BRANCH is untouched.
MSG
  exit 1
fi

echo
echo "Merged $TARGET into $BRANCH. Running fork/check-unlock.sh ..."
echo
if "$ROOT/fork/check-unlock.sh" --since "$PRE"; then CHK=0; else CHK=1; fi
echo
if [ "$CHK" = 0 ]; then
  echo "Next: fork/check-unlock.sh --typecheck, build/test locally (docker compose build), then"
  echo "      git push -u origin $BRANCH   and open a PR into $START_BRANCH (merge it with a merge commit, not a squash/rebase)."
else
  echo "check-unlock reported problems. Fix them on $BRANCH (commit the fixes), re-run fork/check-unlock.sh, then push."
fi
echo "Nothing was pushed; $START_BRANCH is untouched."
exit "$CHK"
