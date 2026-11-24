# ClickHouse low-memory profile: benchmark results

Reproduce with `fork/bench/clickhouse-memory-bench.sh [ROWS]` (writes a markdown table; cleans up its
containers). Numbers below are from a single run each on 2026-11-24; expect +-10-20% noise on timings.

**Machine:** 4 vCPU (Intel Xeon @ 2.10 GHz, Firecracker VM), 15 GiB RAM (`free -g`: total 15), no swap,
Linux 6.18, Docker 29.9.3. Image `clickhouse/clickhouse-server:26.3.62.3`.

**Setups**
- `default`: exactly the four config snippets from the `configs:` section of `docker-compose.yml`
  (network, logging off, resource_limits ratio 0.80, user_settings with max_threads 16 /
  max_memory_usage 32 GB), no container memory limit (as in the stock compose file).
- `low-memory`: the same four snippets plus `fork/clickhouse/low-memory.xml` and
  `low-memory-user.xml` (mounted as `zz_low_memory.xml`), container limit `--memory 1536m`
  (as in `docker-compose.lowmem.yml`).

**Data:** synthetic analytics events (`site_id, timestamp, session_id, user_id, pathname, hostname,
country, browser, device_type, referrer, type, duration`), MergeTree partitioned by month, 90 days,
generated deterministically with `INSERT ... SELECT FROM numbers()` in 1M-row chunks (identical on both
servers, verified by checksum), then `OPTIMIZE FINAL`. 5M rows = 119 MiB on disk, 20M rows = 467 MiB.
Queries: best of 3 runs (warm); "peak MiB" is `memory_usage` from the `X-ClickHouse-Summary` header
(max of the 3 runs). Server memory is read from `/proc/<pid>/status` inside the container.
`VmRSS` includes the ~500 MiB mlock()ed ClickHouse binary (file-backed, identical in both setups), so
**`RssAnon` (heap/threads/caches) is the number the settings actually influence.**

## 5M rows

| Metric | default | low-memory |
|---|---|---|
| Idle server RSS (MiB) | 631 | 583 |
| Idle server RssAnon (MiB) | 122 | 74 |
| Idle container cgroup, `docker stats` (MiB) | 142 | 79 |
| Load time, 5M rows + OPTIMIZE (s) | 5 | 6 |
| RssAnon after load (MiB) | 130 | 90 |
| RssAnon after query phase (MiB) | 396 | 94 |
| 6 dashboard queries in parallel: wall ms / peak RssAnon MiB / failures | 1214 / 596 / 0 | 968 / 211 / 0 |

| Query (best of 3) | default ms | default peak MiB | low ms | low peak MiB |
|---|---|---|---|---|
| uniq users per day (site filter) | 79 | 20 | 92 | 9 |
| top pages (group by path, uniq sessions, top 20) | 293 | 90 | 403 | 41 |
| countIf by browser/device | 48 | 0 | 53 | 0 |
| quantile p50/p95 by country | 39 | 2 | 57 | 1 |
| per-session aggregation (high cardinality GROUP BY) | 232 | 160 | 299 | 128 |
| uniqExact users + sessions | 412 | 284 | 397 | 197 |

## 20M rows

| Metric | default | low-memory |
|---|---|---|
| Idle server RSS (MiB) | 631 | 575 |
| Idle server RssAnon (MiB) | 122 | 66 |
| Idle container cgroup, `docker stats` (MiB) | 142 | 71 |
| Load time, 20M rows + OPTIMIZE (s) | 21 | 22 |
| RssAnon after load (MiB) | 144 | 78 |
| RssAnon after query phase (MiB) | 196 | 92 |
| 6 dashboard queries in parallel: wall ms / peak RssAnon MiB / failures | 2980 / 1383 / 0 | 3530 / 915 / 0 |

| Query (best of 3) | default ms | default peak MiB | low ms | low peak MiB |
|---|---|---|---|---|
| uniq users per day | 189 | 36 | 322 | 25 |
| top pages | 764 | 250 | 1253 | 147 |
| countIf by browser/device | 95 | 1 | 151 | 0 |
| quantile by country | 92 | 2 | 120 | 2 |
| per-session aggregation | 609 | 567 | 1752 | 331 |
| uniqExact users + sessions | 859 | 735 | 1644 | 582 |

## Reading the numbers honestly

- **Idle saving is modest** (~50 MiB RssAnon, ~65 MiB by cgroup accounting). ClickHouse's floor is
  roughly 600 MiB RSS of which most is the mapped binary; no setting removes that.
- **The real benefit is bounded peaks.** Per-query memory drops 20-55% and the 6-way parallel burst peaks
  at 211 vs 596 MiB (5M) and 915 vs 1383 MiB (20M). With `max_server_memory_usage` = 1 GiB and a 1.5 GiB
  container limit the server fails queries cleanly rather than being OOM-killed. No query failed in
  either dataset.
- **The cost is latency on heavy queries.** `max_threads=2` plus spilling GROUP BY at 300 MB makes
  large scans 1.0-1.5x slower at 5M rows and 1.3-2.9x slower at 20M (worst: per-session GROUP BY and
  uniqExact). Light queries (countIf, quantile) are within ~60 ms. This 4-vCPU test box flatters the
  default profile; on a 1-2 vCPU host the thread cap costs little.
- **Not measured:** sustained ingestion plus background merges for days, mark-cache growth on
  multi-GB datasets (default `mark_cache_size` is 5 GiB and only fills as data is read, so the default
  profile's RSS grows with dataset size while the low-memory one stays capped), and the Rybbit backend
  itself. The 20M-row dataset (467 MiB) is small, so the default profile's caches never got large.
- Setting validation on 26.3: every setting loads without warnings. One non-obvious constraint:
  `background_pool_size * background_merges_mutations_concurrency_ratio` must be >= 25
  (`number_of_free_entries_in_pool_to_execute_optimize_entire_partition`) or the server refuses to start;
  2 x 20 is used.
