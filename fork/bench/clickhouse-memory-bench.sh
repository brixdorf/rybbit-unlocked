#!/usr/bin/env bash
# Benchmark default vs low-memory ClickHouse config (rybbit-unlocked fork).
#
# Starts two throwaway containers (chbench-default on :18123, chbench-low on :18124),
# loads identical synthetic analytics events, runs dashboard-style queries and
# prints a markdown report. Does not touch the compose stack's containers/volumes.
#
# Data is deterministic (hash of row number), so both servers get identical rows.
# Usage: fork/bench/clickhouse-memory-bench.sh [ROWS] [OUT.md]
#   ROWS default 5000000, OUT default fork/bench/RESULTS.raw.md
set -euo pipefail

ROWS="${1:-5000000}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${2:-$ROOT/fork/bench/RESULTS.raw.md}"
IMAGE="${CH_IMAGE:-clickhouse/clickhouse-server:26.3.62.3}"
LOW_MEM_LIMIT="${LOW_MEM_LIMIT:-1536m}"   # same as docker-compose.lowmem.yml
TMP="$(mktemp -d)"
PW=frog
CD=chbench-default
CL=chbench-low

cleanup() {
  [ -n "${SAMPLER_PID:-}" ] && kill "$SAMPLER_PID" 2>/dev/null || true
  docker rm -f "$CD" "$CL" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# --- Base config: replicated from the `configs:` section of docker-compose.yml -----------
cat >"$TMP/network.xml" <<'X'
<clickhouse><listen_host>0.0.0.0</listen_host></clickhouse>
X
cat >"$TMP/logging_rules.xml" <<'X'
<clickhouse>
  <logger><level>warning</level><console>true</console></logger>
  <query_thread_log remove="remove"/><query_log remove="remove"/><query_views_log remove="remove"/>
  <query_metric_log remove="remove"/><error_log remove="remove"/><opentelemetry_span_log remove="remove"/>
  <text_log remove="remove"/><trace_log remove="remove"/><metric_log remove="remove"/>
  <asynchronous_metric_log remove="remove"/><session_log remove="remove"/><part_log remove="remove"/>
  <latency_log remove="remove"/><processors_profile_log remove="remove"/>
</clickhouse>
X
cat >"$TMP/resource_limits.xml" <<'X'
<clickhouse>
  <max_server_memory_usage_to_ram_ratio>0.80</max_server_memory_usage_to_ram_ratio>
  <concurrent_threads_soft_limit_ratio_to_cores>1</concurrent_threads_soft_limit_ratio_to_cores>
  <merges_mutations_memory_usage_to_ram_ratio>0.25</merges_mutations_memory_usage_to_ram_ratio>
</clickhouse>
X
cat >"$TMP/user_settings.xml" <<'X'
<clickhouse><profiles><default>
  <enable_json_type>1</enable_json_type><async_insert>1</async_insert><wait_for_async_insert>1</wait_for_async_insert>
  <log_queries>0</log_queries><log_query_threads>0</log_query_threads><log_processors_profiles>0</log_processors_profiles>
  <max_memory_usage>32000000000</max_memory_usage><max_threads>16</max_threads>
</default></profiles></clickhouse>
X

base_mounts=(
  -v "$TMP/network.xml:/etc/clickhouse-server/config.d/network.xml:ro"
  -v "$TMP/logging_rules.xml:/etc/clickhouse-server/config.d/logging_rules.xml:ro"
  -v "$TMP/resource_limits.xml:/etc/clickhouse-server/config.d/resource_limits.xml:ro"
  -v "$TMP/user_settings.xml:/etc/clickhouse-server/users.d/user_settings.xml:ro"
)
envs=(-e CLICKHOUSE_PASSWORD=$PW -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1)

docker rm -f "$CD" "$CL" >/dev/null 2>&1 || true
docker run -d --name "$CD" -p 127.0.0.1:18123:8123 "${envs[@]}" "${base_mounts[@]}" "$IMAGE" >/dev/null
docker run -d --name "$CL" -p 127.0.0.1:18124:8123 "${envs[@]}" --memory "$LOW_MEM_LIMIT" "${base_mounts[@]}" \
  -v "$ROOT/fork/clickhouse/low-memory.xml:/etc/clickhouse-server/config.d/zz_low_memory.xml:ro" \
  -v "$ROOT/fork/clickhouse/low-memory-user.xml:/etc/clickhouse-server/users.d/zz_low_memory.xml:ro" \
  "$IMAGE" >/dev/null

url() { [ "$1" = "$CD" ] && echo "http://127.0.0.1:18123" || echo "http://127.0.0.1:18124"; }
# q <container> <sql>  -> body on stdout, summary header on $TMP/hdr
q() { curl -sS --fail-with-body -D "$TMP/hdr" -u "default:$PW" --data-binary "$2" "$(url "$1")/?wait_end_of_query=1"; }

for c in "$CD" "$CL"; do
  for _ in $(seq 60); do q "$c" "SELECT 1" >/dev/null 2>&1 && break; sleep 1; done
  q "$c" "SELECT 1" >/dev/null
done

# proc_mb <container> <VmRSS|RssAnon>: max over clickhouse processes, MiB.
# VmRSS includes the ~600 MiB clickhouse binary that is mlock()ed (file-backed, same in both
# configs); RssAnon is the heap/thread memory that the settings actually influence.
proc_mb() {
  docker exec "$1" sh -c "for p in /proc/[0-9]*; do n=\$(cat \$p/comm 2>/dev/null); if [ \"\$n\" = clickhouse-serv ] || [ \"\$n\" = clickhouse ]; then grep $2 \$p/status; fi; done; true" \
    | awk '{s=$2>s?$2:s} END{printf "%.0f", s/1024}' || true
}
rss_mb() { proc_mb "$1" VmRSS; }
anon_mb() { proc_mb "$1" RssAnon; }
cg_mb() { # container cgroup usage (docker stats, excludes inactive page cache)
  docker stats --no-stream --format '{{.MemUsage}}' "$1" | awk '{v=$1; if (v ~ /GiB/) {sub(/GiB/,"",v); v*=1024} else {sub(/MiB/,"",v)} printf "%.0f", v}'
}

sleep 20
IDLE_D=$(rss_mb "$CD"); IDLE_L=$(rss_mb "$CL")
IDLE_A_D=$(anon_mb "$CD"); IDLE_A_L=$(anon_mb "$CL")
IDLE_CG_D=$(cg_mb "$CD"); IDLE_CG_L=$(cg_mb "$CL")

SCHEMA="CREATE TABLE bench.events (
  site_id UInt16, timestamp DateTime, session_id String, user_id String, pathname String,
  hostname LowCardinality(String), country LowCardinality(String), browser LowCardinality(String),
  device_type LowCardinality(String), referrer String, type LowCardinality(String), duration UInt32
) ENGINE = MergeTree PARTITION BY toYYYYMM(timestamp) ORDER BY (site_id, toDate(timestamp), session_id, timestamp)"

STEP=1000000
[ "$ROWS" -lt "$STEP" ] && STEP=$ROWS
load() {
  local c=$1 off=0
  q "$c" "DROP DATABASE IF EXISTS bench" >/dev/null
  q "$c" "CREATE DATABASE bench" >/dev/null
  q "$c" "$SCHEMA" >/dev/null
  while [ "$off" -lt "$ROWS" ]; do
    q "$c" "INSERT INTO bench.events SELECT
        toUInt16(1 + intDiv(cityHash64(number, 1) % 100, 90)) AS site_id,
        toDateTime('2026-08-01 00:00:00') + intDiv(number * 90 * 86400, $ROWS) + cityHash64(number, 2) % 600 AS timestamp,
        concat('s', toString(intDiv(number, 4))) AS session_id,
        concat('u', toString(intDiv(number, 10) % 300000)) AS user_id,
        concat('/', arrayElement(['', 'blog', 'pricing', 'docs', 'about', 'contact', 'shop', 'cart'], 1 + cityHash64(number, 3) % 8), '/', toString(cityHash64(number, 4) % 2000)) AS pathname,
        'example.com',
        arrayElement(['US','DE','GB','FR','IN','BR','CA','NL','ES','JP'], 1 + cityHash64(number, 5) % 10),
        arrayElement(['Chrome','Firefox','Safari','Edge','Opera'], 1 + cityHash64(number, 6) % 5),
        arrayElement(['Desktop','Mobile','Tablet'], 1 + cityHash64(number, 7) % 3),
        concat('https://ref', toString(cityHash64(number, 8) % 500), '.example/'),
        arrayElement(['pageview','pageview','pageview','custom_event'], 1 + cityHash64(number, 9) % 4),
        toUInt32(cityHash64(number, 10) % 600)
      FROM numbers($off,$STEP)" >/dev/null
    off=$((off + STEP))
  done
  q "$c" "OPTIMIZE TABLE bench.events FINAL" >/dev/null
}

echo "loading $ROWS rows into both..." >&2
T0=$(date +%s); load "$CD"; LOAD_D=$(( $(date +%s) - T0 ))
T0=$(date +%s); load "$CL"; LOAD_L=$(( $(date +%s) - T0 ))
sleep 5
LOADED_D=$(rss_mb "$CD"); LOADED_L=$(rss_mb "$CL")
LOADED_A_D=$(anon_mb "$CD"); LOADED_A_L=$(anon_mb "$CL")
ROWCOUNT=$(q "$CD" "SELECT count() FROM bench.events")
DISK=$(q "$CD" "SELECT formatReadableSize(sum(bytes_on_disk)) FROM system.parts WHERE database='bench' AND active")
CHECK_D=$(q "$CD" "SELECT sum(cityHash64(session_id,user_id,pathname)) FROM bench.events")
CHECK_L=$(q "$CL" "SELECT sum(cityHash64(session_id,user_id,pathname)) FROM bench.events")
[ "$CHECK_D" = "$CHECK_L" ] || { echo "datasets differ" >&2; exit 1; }

QNAMES=(uniq_per_day top_pages countif_browser quantile_country sessions_highcard uniqexact_users)
QSQL=(
"SELECT toDate(timestamp) d, uniq(user_id), count() FROM bench.events WHERE site_id=1 GROUP BY d ORDER BY d FORMAT Null"
"SELECT pathname, count() c, uniq(session_id) FROM bench.events WHERE site_id=1 AND type='pageview' GROUP BY pathname ORDER BY c DESC LIMIT 20 FORMAT Null"
"SELECT browser, countIf(device_type='Mobile'), countIf(device_type='Desktop'), count() FROM bench.events GROUP BY browser FORMAT Null"
"SELECT country, quantile(0.5)(duration), quantile(0.95)(duration), avg(duration) FROM bench.events WHERE timestamp > '2026-09-01' GROUP BY country FORMAT Null"
"SELECT count(), avg(n), avg(dur) FROM (SELECT session_id, count() n, max(timestamp)-min(timestamp) dur FROM bench.events GROUP BY session_id) FORMAT Null"
"SELECT uniqExact(user_id), uniqExact(session_id) FROM bench.events FORMAT Null"
)

# peak RssAnon sampler (server process) during the concurrent phase
sample() { # sample <container> <file>
  local m=0 v
  while true; do v=$(anon_mb "$1" 2>/dev/null || echo 0); if [ "${v:-0}" -gt "$m" ]; then m=$v; echo "$m" >"$2.tmp" && mv "$2.tmp" "$2"; fi; sleep 0.2; done
}

summ() { grep -i '^x-clickhouse-summary' "$TMP/hdr" | tr -d '\r' | sed 's/^[^:]*: *//'; }
jget() { echo "$1" | grep -o "\"$2\":\"[0-9]*\"" | grep -o '[0-9]*' || echo 0; }

declare -A RES
for i in "${!QNAMES[@]}"; do
  for c in "$CD" "$CL"; do
    best=999999; mem=0; status=ok
    for run in 1 2 3; do
      s=$(date +%s%N)
      if q "$c" "${QSQL[$i]}" >"$TMP/body" 2>&1; then :; else status="FAILED: $(head -c 120 "$TMP/body" | tr '\n' ' ')"; fi
      ms=$(( ($(date +%s%N) - s) / 1000000 ))
      [ "$ms" -lt "$best" ] && best=$ms
      sm=$(summ); m=$(jget "$sm" memory_usage); [ "${m:-0}" -gt "$mem" ] && mem=$m
    done
    RES["$i,$c"]="$best|$((mem/1024/1024))|$status"
  done
done

# concurrent mix: 6 parallel dashboard queries, wall time + peak container memory
echo 0 >"$TMP/peakD"; echo 0 >"$TMP/peakL"
sample "$CD" "$TMP/peakD" & SAMPLER_PID=$!
conc() {
  local c=$1 s=$(date +%s%N)
  for i in 0 1 2 3 4 5; do ( q "$c" "${QSQL[$i]}" >/dev/null 2>&1 || echo "fail $i" >>"$TMP/fail_$c" ) & done
  wait
  echo $(( ($(date +%s%N) - s) / 1000000 ))
}
# note: q() writes headers to a shared file; concurrent use only cares about wall time
CONC_D=$(conc "$CD" 2>/dev/null | tail -1); kill "$SAMPLER_PID" 2>/dev/null || true
sample "$CL" "$TMP/peakL" & SAMPLER_PID=$!
CONC_L=$(conc "$CL" 2>/dev/null | tail -1); kill "$SAMPLER_PID" 2>/dev/null || true; SAMPLER_PID=
CONC_PEAK_D=$(cat "$TMP/peakD"); CONC_PEAK_L=$(cat "$TMP/peakL")
CONC_FAIL_L=$( [ -f "$TMP/fail_$CL" ] && wc -l <"$TMP/fail_$CL" || echo 0 )
CONC_FAIL_D=$( [ -f "$TMP/fail_$CD" ] && wc -l <"$TMP/fail_$CD" || echo 0 )
AFTER_D=$(rss_mb "$CD"); AFTER_L=$(rss_mb "$CL")
AFTER_A_D=$(anon_mb "$CD"); AFTER_A_L=$(anon_mb "$CL")

{
  echo "# Raw benchmark output ($(date -u +%FT%TZ))"
  echo
  echo "Machine: $(nproc) vCPU, $(free -m | awk '/Mem:/{print $2}') MiB RAM, $(uname -r); image $IMAGE; rows $ROWCOUNT; on-disk $DISK"
  echo
  echo "| Metric | default | low-memory |"; echo "|---|---|---|"
  echo "| Idle server RSS (MiB) | $IDLE_D | $IDLE_L |"
  echo "| Idle server RssAnon (MiB) | $IDLE_A_D | $IDLE_A_L |"
  echo "| Idle container cgroup, docker stats (MiB) | $IDLE_CG_D | $IDLE_CG_L |"
  echo "| Load time (s) | $LOAD_D | $LOAD_L |"
  echo "| Server RSS after load + OPTIMIZE (MiB) | $LOADED_D | $LOADED_L |"
  echo "| Server RssAnon after load (MiB) | $LOADED_A_D | $LOADED_A_L |"
  echo "| Server RSS after queries (MiB) | $AFTER_D | $AFTER_L |"
  echo "| Server RssAnon after queries (MiB) | $AFTER_A_D | $AFTER_A_L |"
  echo "| 6 concurrent queries: wall ms / peak RssAnon MiB / failures | $CONC_D / $CONC_PEAK_D / $CONC_FAIL_D | $CONC_L / $CONC_PEAK_L / $CONC_FAIL_L |"
  echo
  echo "| Query | default best ms | default peak MiB | low best ms | low peak MiB | low status |"; echo "|---|---|---|---|---|---|"
  for i in "${!QNAMES[@]}"; do
    IFS='|' read -r dm dmem dst <<<"${RES["$i,$CD"]}"
    IFS='|' read -r lm lmem lst <<<"${RES["$i,$CL"]}"
    echo "| ${QNAMES[$i]} | $dm | $dmem | $lm | $lmem | $lst |"
  done
} | tee "$OUT"
