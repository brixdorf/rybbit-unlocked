# fork/: maintaining rybbit-unlocked

This directory holds everything specific to the fork that is not part of the unlock patch itself:
sync tooling, the review allowlist, and the low-memory profile. Upstream is
<https://github.com/rybbit-io/rybbit> (AGPL-3.0). See `../UNLOCK.md` for what the patch changes and why.

## The fork model

- **The patch.** A flag `UNLOCK_CLOUD_FEATURES` (server) / `NEXT_PUBLIC_UNLOCK_CLOUD_FEATURES` (client,
  baked in at build time) defines `CLOUD_FEATURES = IS_CLOUD || UNLOCK_CLOUD_FEATURES`. Feature gates that
  only need their own runtime dependencies use `CLOUD_FEATURES`; billing, quotas, signup flows, telemetry
  and cloud-infra keep `IS_CLOUD` (so billing is never switched on). Wiring: `server/src/lib/const.ts`,
  `client/src/lib/const.ts`, `client/next.config.ts`, `client/Dockerfile`, `docker-compose.yml`, `.env.example`.
- **Branch model.** The main fork branch = upstream + this small patch. It is a *published* branch, so we
  integrate upstream by **merge, never rebase** (rebasing would rewrite history that others pulled).
  Each sync happens on a throwaway `sync/<target>` branch, is verified, then merged into the main branch
  through a PR with a merge commit (not squash; squashing loses the upstream ancestry and the next merge
  would re-conflict on everything). `git rerere` is enabled by the sync script, so a conflict resolved once
  is replayed automatically next time.
- **Images are built locally.** `NEXT_PUBLIC_*` values are compiled into the Next.js client, and upstream's
  images do not contain the patch. Never `docker compose pull` backend/client and never use upstream's
  `update.sh` (`git stash; git pull; docker compose pull` drops the patch and swaps in upstream images).
  Use `fork/update.sh`.
- **Current base:** this repo's history is a shallow clone of upstream master at `a46032b` (172 commits
  after v2.9.3). `sync-upstream.sh` unshallows it on first run.

## Files

| File | Purpose |
|---|---|
| `sync-upstream.sh` | merge an upstream release/master into a new `sync/<target>` branch, then run the checks |
| `check-unlock.sh` | verify patch integrity, review `IS_CLOUD` uses against the allowlist, list schema changes, optional typecheck |
| `update-allowlist.sh` | print allowlist candidate lines (reason `TODO`) for new `IS_CLOUD` uses |
| `is-cloud-allowlist.txt` | reviewed remaining `IS_CLOUD` uses: `path<TAB>trimmed line<TAB>reason` |
| `expected-unlock-count.txt` | minimum number of `CLOUD_FEATURES` gate lines; regenerate with `check-unlock.sh --record` |
| `update.sh` | production updater for self-hosters of this fork |
| `clickhouse/low-memory*.xml`, `../docker-compose.lowmem.yml` | low-memory profile |
| `bench/` | ClickHouse memory benchmark script and results |

## Syncing a new upstream release, step by step

1. Start from a clean checkout of the main fork branch (`git status` clean for tracked files).
2. `fork/sync-upstream.sh --dry-run` shows what it would do. Then run it:
   - no argument: latest upstream `vX.Y.Z` tag that is newer than the merge base *and* on upstream/master;
   - `fork/sync-upstream.sh v2.10.0` for a specific tag, `--master` for upstream/master;
   - patch tags that live on side branches (v2.9.2, v2.9.3 are not ancestors of master) are refused unless
     `--allow-side-branch`; their fixes arrive with the next minor or via `--master`.
   It adds the `upstream` remote, enables rerere, fetches (unshallowing once), creates `sync/<target>`, and runs
   `git merge --no-ff -m "chore(upstream): merge <target>"`. It never pushes and never touches your branch.
3. **Clean merge:** the script runs `check-unlock.sh` for you. **Conflicts:** it lists the files and stops.
   Resolve (see below), `git add`, `git commit --no-edit`, then `fork/check-unlock.sh --since <sha before merge>`.
4. Fix everything `check-unlock.sh` reports (below), then `fork/check-unlock.sh --typecheck`.
5. Build and smoke-test: `docker compose build && docker compose up -d`, open the dashboard, check the unlocked
   pages (Search Console, Globe, etc.) and that no billing UI shows up.
6. `git push -u origin sync/<target>`, open a PR into the main branch, merge with a **merge commit**.
7. On production hosts: `fork/update.sh` (add `COMPOSE_FILES="docker-compose.lowmem.yml"` for the low-memory profile).
   If `check-unlock.sh` listed new migrations, take a `pg_dump` / ClickHouse backup first; migrations run on backend start.

### Resolving typical conflicts

Rule of thumb: **take upstream's version of the surrounding code, then re-apply the one-token swap
`IS_CLOUD` -> `CLOUD_FEATURES`** (and the import) where the gate is a feature. Never resolve by taking "ours"
wholesale on a file upstream changes every release; you would silently revert upstream's work.

- `client/src/app/[site]/components/Sidebar/Sidebar.tsx`, `client/src/components/SiteSettings/TrackingTab.tsx`:
  upstream adds/reorders items and gates each with `IS_CLOUD`. Accept upstream's block, then re-swap gates that
  are features (import `CLOUD_FEATURES` next to `IS_CLOUD`).
- `server/src/lib/const.ts`, `client/src/lib/const.ts`: keep upstream's constants, keep our 3 lines
  (`UNLOCK_CLOUD_FEATURES`, `CLOUD_FEATURES`, comment) right after the `IS_CLOUD` definition.
- `server/src/index.ts`: upstream registers routes/cron under `if (IS_CLOUD)`. Accept upstream's registrations;
  routes/jobs that only need their own dependencies (not Stripe/billing) go under `CLOUD_FEATURES`.
- `docker-compose.yml`: keep upstream's changes; make sure the three `UNLOCK_CLOUD_FEATURES` lines survive
  (backend env, client build arg, client env) and the `build:` sections stay.
- `client/Dockerfile`: keep upstream's changes plus our `ARG`/`ENV NEXT_PUBLIC_UNLOCK_CLOUD_FEATURES` pair.
  If upstream adds a new `NEXT_PUBLIC_*` it must be added in three places: Dockerfile ARG+ENV, compose build arg.
- Lockfiles/package.json: take upstream's, then `pnpm install` and commit the lockfile.
- A `modify/delete` conflict on a file upstream deleted: delete it if our patch touched only gates in it.

### Classifying new `IS_CLOUD` uses

`check-unlock.sh` fails (exit 1) on any `IS_CLOUD` line (client/src, server/src, non-test, imports ignored)
that is not in `is-cloud-allowlist.txt` (matched by path + trimmed line text). For each one:

| It gates... | Action |
|---|---|
| a feature whose backend/UI works without a subscription (integrations, extra reports, admin tools, AI, exports, session replay options...) | change code to `CLOUD_FEATURES` (import from `lib/const`) |
| billing, Stripe, plan/subscription/usage limits, quotas, upgrade prompts | keep `IS_CLOUD`; allowlist with reason `billing` / `quota` |
| open signup / marketing / pricing UI | keep; reason `signup` or `commercial-ui` |
| telemetry or cloud-only infra (workers, regional services) | keep; reason `telemetry` / `cloud-infra` |

`fork/update-allowlist.sh` prints ready-to-edit `path<TAB>line<TAB>TODO` lines. If unsure whether a feature
works self-hosted, read what it imports (Stripe client? hosted-only env var?) and try it. After changing
gates, update the minimum with `fork/check-unlock.sh --record` (a *drop* in gate count after a merge means a
conflict resolution swallowed gates, which is why the count is a floor). Stale allowlist entries (code changed
upstream) only warn; prune them when convenient.

### `check-unlock.sh`

`fork/check-unlock.sh [--since REF] [--typecheck] [--record]`: (a) patch integrity (definitions, Dockerfile,
compose and next.config wiring, `CLOUD_FEATURES` count >= `expected-unlock-count.txt`); (b) `IS_CLOUD` review;
(c) informational list of changed Drizzle migrations / `server/src/db` / `clickhouse/` files since the last
`chore(upstream): merge` commit (or `--since`); (d) `--typecheck` builds `shared` and typechecks client and server.
`IS_CLOUD` usage grows every release, so expect to review a handful of new lines per sync.

## Low-memory profile

For small sites/VPSes (2-4 GB). ClickHouse stays; this caps its caches, threads and per-query memory.

```bash
docker compose -f docker-compose.yml -f docker-compose.lowmem.yml up -d
# updates:
COMPOSE_FILES="docker-compose.lowmem.yml" fork/update.sh
```

It mounts `fork/clickhouse/low-memory.xml` (server: `max_server_memory_usage` 1 GiB, mark cache 128 MiB,
uncompressed cache off, 2 background merge threads, `max_concurrent_queries` 20, ...) and
`low-memory-user.xml` (profile: `max_threads` 2, `max_memory_usage` 700 MiB, external GROUP BY/sort spill at
300 MiB, async insert kept) into ClickHouse, gives the container `mem_limit: 1536m`, runs Postgres with
`shared_buffers=64MB`, Redis with `maxmemory 192mb` (noeviction kept), and the backend in single-process
mode (`CLUSTER_WORKERS=0`). All settings were validated against ClickHouse 26.3.62.3 (server starts without
warnings; `system.server_settings`/`system.settings` show them as changed).
Remember the Redis `command:` is replaced wholesale by the overlay, so keep it in sync with `docker-compose.yml`.

**Benchmark summary** (4 vCPU box, 5M and 20M synthetic event rows; full tables in `bench/RESULTS.md`,
rerun with `fork/bench/clickhouse-memory-bench.sh`):

- Idle heap (RssAnon) 122 -> 74 MiB; container 142 -> 79 MiB (the ~600 MiB RSS floor is the mapped binary).
- Peak memory per dashboard query down 20-55%; 6 parallel queries peak 596 -> 211 MiB (5M rows), 1383 -> 915 MiB (20M).
- Cost: heavy scans are 1.0-1.5x slower at 5M rows, up to ~2.9x slower for the highest-cardinality GROUP BY at 20M.
- It does not make ClickHouse small; it makes it predictable. Use it when RAM, not CPU, is the constraint.

## Release pattern observed upstream

From upstream tags (v2.x):

| Release | Date | Days since previous minor | Master commits since previous minor |
|---|---|---|---|
| v2.3.0 | 2026-01-01 | 41 (from v2.2.0, 2025-11-21) | n/a |
| v2.4.0 | 2026-02-11 | 41 | 136 |
| v2.5.0 | 2026-03-29 | 46 | 189 |
| v2.6.0 | 2026-05-13 | 45 | 72 |
| v2.7.0 | 2026-07-06 | 54 | 127 |
| v2.8.0 | 2026-07-26 | 20 | 130 |
| v2.9.0 | 2026-09-11 | 47 | 93 |

- A minor roughly every 6-8 weeks (range 3-8 weeks), typically 70-190 master commits each.
- Patch releases (v2.9.1 on 09-11, v2.9.2 on 10-22, v2.9.3 on 11-17) are cut from side branches off the minor
  (v2.9.2/v2.9.3 are not ancestors of master). Their fixes also land on master, so sync minors or master, not patch tags.
- At the time of writing master was 172 commits past v2.9.3 and this fork was exactly at that master.
- Files that change nearly every release and overlap with our patch: `Sidebar.tsx`, `TrackingTab.tsx`,
  `docker-compose.yml`, `client/Dockerfile`, `server/src/lib/const.ts`, `server/src/index.ts`. Budget a short
  conflict session per minor, and sync often (monthly against master is cheaper than a big-bang per minor
  because each merge conflicts only on what changed since the last).
- `IS_CLOUD` usage grows with each release; the allowlist check is the guard against silently losing features.
