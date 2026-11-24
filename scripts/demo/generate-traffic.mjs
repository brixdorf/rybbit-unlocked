#!/usr/bin/env node
/**
 * Rybbit demo traffic generator.
 *
 * Simulates the visitors of a fictional international SaaS site ("Lumenly")
 * against a running Rybbit backend so that every dashboard feature has data.
 *
 *   node scripts/demo/generate-traffic.mjs --site-id 1 --api-key rb_xxx
 *
 * See scripts/demo/README.md. Zero npm dependencies: built-in fetch only. The
 * optional --check-geo / --dry-run validation borrows the server's own
 * node_modules (maxmind reader, ua-parser-js, zod schema from server/dist).
 *
 * How ingestion works (read from server/src):
 *  - POST {base}/api/track  (public) takes ONE event per request, strict zod
 *    schema in server/src/services/tracker/trackingPayload.ts.
 *  - POST {base}/api/identify (public) links anonymous_id -> user_id + traits.
 *  - The event timestamp is the server receive time. The payload cannot carry
 *    a timestamp, so history can only be created through the Umami import
 *    path (POST /api/sites/:id/imports + .../imports/:importId/events), which
 *    needs an API key (sites:write). Imported rows carry pageviews and custom
 *    events only (no props, errors, vitals, clicks).
 *  - The client IP is X-Real-IP, else the first X-Forwarded-For entry, else the
 *    socket (resolveClientIp.ts, no Cloudflare headers are sent). It is
 *    geolocated with GeoLite2-City.mmdb. A bearer key with `ingest:write` plus
 *    --trusted lets the payload carry ip_address/user_agent instead (bot
 *    detection is then reduced to the user-agent layer).
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, "../../server");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `Rybbit demo traffic generator

Usage: node scripts/demo/generate-traffic.mjs [options]

  --base-url <url>      Backend URL (default http://localhost:3001, env RYBBIT_BASE_URL)
  --site-id <id>        Site id (numeric id needed for backfill/setup), env RYBBIT_SITE_ID
  --api-key <key>       API key (sites:write for backfill/--setup, ingest:write for --trusted), env RYBBIT_API_KEY
  --visitors <n>        Unique human visitors to simulate (default 600)
  --days <n>            History window in days (default 30). Needs --api-key; without it
                        everything is sent live and stamped "now"
  --rich <n>            Visitors whose first visit is "today" and sent through /api/track with
                        every event type (default max(60, 15% of visitors))
  --bots <n>            Bot visitors (default 4% of visitors)
  --live [minutes]      After the batch, keep sending a trickle of visitors for N minutes (default 5)
  --live-rate <n>       Live visitors per minute (default 8)
  --seed <n>            PRNG seed (default 42) - same seed, same simulation
  --hostname <host>     Hostname the simulated site is served from (default demo.lumenly.example)
  --concurrency <n>     Parallel visitors (default 6)
  --time-scale <x>      Multiplier for dwell time between live events (default 0.02 = 50x faster)
  --live-time-scale <x> Same, for the --live phase (default 0.2)
  --trusted             Send ip_address/user_agent in the payload with the API key (needs ingest:write)
  --setup               Enable site tracking features (web vitals, errors, clicks...) and create
                        demo goals + funnels. Needs --api-key and a numeric --site-id
  --no-backfill         Skip the historical import even if an API key is given
  --check-geo           Print country/city/ASN for every simulated IP (reads server/GeoLite2-*.mmdb)
                        and verify user-agent parsing, then exit
  --dry-run [n]         Do not send anything; print the first n requests (default 8) and validate
                        every payload against the server's zod schema and the Umami import mapper
  --help                This text
`;

function parseArgs(argv) {
  const o = {};
  const bool = new Set(["trusted", "setup", "no-backfill", "check-geo", "help"]);
  const optNum = new Set(["live", "dry-run"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    if (bool.has(key)) o[key] = true;
    else if (optNum.has(key)) {
      const next = argv[i + 1];
      if (next !== undefined && /^\d+(\.\d+)?$/.test(next)) {
        o[key] = Number(next);
        i++;
      } else o[key] = true;
    } else {
      const next = argv[++i];
      if (next === undefined) throw new Error(`Missing value for ${a}`);
      o[key] = next;
    }
  }
  return o;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(String(e.message || e));
  console.error(HELP);
  process.exit(2);
}
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const CFG = {
  baseUrl: String(args["base-url"] ?? process.env.RYBBIT_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, ""),
  siteId: String(args["site-id"] ?? process.env.RYBBIT_SITE_ID ?? ""),
  apiKey: String(args["api-key"] ?? process.env.RYBBIT_API_KEY ?? ""),
  visitors: Math.max(1, Math.floor(num(args.visitors, 600))),
  days: Math.max(1, Math.floor(num(args.days, 30))),
  seed: Math.floor(num(args.seed, 42)),
  hostname: String(args.hostname ?? "demo.lumenly.example"),
  concurrency: Math.max(1, Math.floor(num(args.concurrency, 6))),
  timeScale: num(args["time-scale"], 0.02),
  liveTimeScale: num(args["live-time-scale"], 0.2),
  liveMinutes: args.live === undefined ? 0 : args.live === true ? 5 : Number(args.live),
  liveRate: num(args["live-rate"], 8),
  trusted: !!args.trusted,
  setup: !!args.setup,
  noBackfill: !!args["no-backfill"],
  checkGeo: !!args["check-geo"],
  dryRun: args["dry-run"] === undefined ? 0 : args["dry-run"] === true ? 8 : Math.max(1, Math.floor(args["dry-run"])),
};
CFG.rich = Math.min(CFG.visitors, Math.max(0, Math.floor(num(args.rich, Math.max(60, Math.round(CFG.visitors * 0.15))))));
CFG.bots = Math.max(0, Math.floor(num(args.bots, Math.round(CFG.visitors * 0.04))));

// ---------------------------------------------------------------------------
// Deterministic PRNG + helpers
// ---------------------------------------------------------------------------

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(CFG.seed);
const chance = p => rng() < p;
const randInt = (a, b) => a + Math.floor(rng() * (b - a + 1));
const pick = arr => arr[Math.floor(rng() * arr.length)];
function pickW(items, weightOf = x => x[0]) {
  let total = 0;
  for (const it of items) total += weightOf(it);
  let r = rng() * total;
  for (const it of items) {
    r -= weightOf(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}
function gauss() {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
const lognormal = (median, sigma) => median * Math.exp(sigma * gauss());
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const hex = n => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join("");
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(["8", "9", "a", "b"])}${hex(3)}-${hex(12)}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const bump = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

// ---------------------------------------------------------------------------
// World data: countries -> cities -> real ISP IPs (verified with --check-geo)
// [country, city, region (ISO 3166-2 suffix as stored by Rybbit), timezone, [ips]]
// ---------------------------------------------------------------------------

const GEO_ROWS = [
  ["US", "Chicago", "IL", "America/Chicago", ["73.73.139.131", "73.246.87.197", "73.168.46.216"]],
  ["US", "New York", "NY", "America/New_York", ["98.7.38.3", "98.116.12.201", "98.15.183.208"]],
  ["US", "Houston", "TX", "America/Chicago", ["73.232.247.177", "73.77.96.29", "73.183.194.123"]],
  ["US", "Philadelphia", "PA", "America/New_York", ["73.188.228.183", "73.233.143.200", "73.141.184.254"]],
  ["US", "Pittsburgh", "PA", "America/New_York", ["73.79.194.145", "73.174.164.180", "98.236.78.60"]],
  ["US", "Seattle", "WA", "America/Los_Angeles", ["73.140.96.151", "73.225.9.79", "98.96.252.166"]],
  ["IN", "Bengaluru", "KA", "Asia/Kolkata", ["49.37.162.241", "157.45.247.213", "157.35.12.152"]],
  ["IN", "Kolkata", "WB", "Asia/Kolkata", ["49.37.37.48", "157.40.177.203", "117.197.1.18"]],
  ["IN", "Hyderabad", "TS", "Asia/Kolkata", ["49.37.132.140", "157.35.103.8", "117.206.241.30"]],
  ["IN", "Jaipur", "RJ", "Asia/Kolkata", ["49.36.244.76", "157.38.49.253", "157.33.31.222"]],
  ["IN", "Pune", "MH", "Asia/Kolkata", ["49.36.50.73", "157.32.166.10", "117.248.63.57"]],
  ["IN", "Lucknow", "UP", "Asia/Kolkata", ["49.36.216.107", "157.34.227.34", "117.235.190.36"]],
  ["DE", "Berlin", "BE", "Europe/Berlin", ["91.32.102.133", "91.26.126.3", "91.1.8.234"]],
  ["DE", "Hamburg", "HH", "Europe/Berlin", ["91.37.252.40", "91.24.68.8", "91.14.141.175"]],
  ["DE", "Stuttgart", "BW", "Europe/Berlin", ["91.23.55.37", "87.191.106.21", "87.180.236.94"]],
  ["DE", "Hanover", "NI", "Europe/Berlin", ["91.22.184.202", "91.34.48.183", "91.6.194.95"]],
  ["DE", "Munich", "BY", "Europe/Berlin", ["91.7.30.193", "91.6.211.166", "91.42.17.0"]],
  ["DE", "Dortmund", "NW", "Europe/Berlin", ["91.32.126.64", "87.185.44.99", "87.162.176.222"]],
  ["GB", "Nottingham", "ENG", "Europe/London", ["81.128.8.223", "81.144.26.166", "81.141.124.143"]],
  ["GB", "City of London", "ENG", "Europe/London", ["86.156.255.221", "86.155.71.107", "86.153.227.131"]],
  ["GB", "Manchester", "ENG", "Europe/London", ["81.132.123.222", "81.135.202.55", "81.155.228.40"]],
  ["GB", "Glasgow", "SCT", "Europe/London", ["81.154.12.79", "81.129.35.66", "81.152.91.146"]],
  ["GB", "Birmingham", "ENG", "Europe/London", ["81.147.106.36", "81.133.207.18", "81.150.68.20"]],
  ["GB", "Bedford", "ENG", "Europe/London", ["81.144.223.123", "81.147.20.94", "81.141.182.192"]],
  ["BR", "São Paulo", "SP", "America/Sao_Paulo", ["177.215.22.196", "177.26.241.206", "177.103.140.159"]],
  ["BR", "Rio de Janeiro", "RJ", "America/Sao_Paulo", ["177.142.6.113", "177.157.219.104", "177.124.217.239"]],
  ["BR", "Belo Horizonte", "MG", "America/Sao_Paulo", ["177.212.62.233", "177.199.133.102", "177.182.182.190"]],
  ["BR", "Curitiba", "PR", "America/Sao_Paulo", ["177.220.164.233", "177.207.210.6", "177.96.119.139"]],
  ["BR", "Porto Alegre", "RS", "America/Sao_Paulo", ["177.67.35.120", "177.138.41.197", "177.23.210.221"]],
  ["BR", "Salvador", "BA", "America/Bahia", ["177.21.4.198", "177.16.248.56", "177.20.55.165"]],
  ["JP", "Tokyo", "13", "Asia/Tokyo", ["133.65.96.197", "133.32.173.63", "133.11.73.116"]],
  ["JP", "Osaka", "27", "Asia/Tokyo", ["133.206.217.96", "133.167.147.31", "153.203.9.46"]],
  ["JP", "Sapporo", "01", "Asia/Tokyo", ["133.87.111.102", "133.50.234.130", "153.173.12.238"]],
  ["JP", "Kanazawa", "17", "Asia/Tokyo", ["133.165.250.199", "133.28.138.71", "153.131.174.151"]],
  ["JP", "Kyoto", "26", "Asia/Tokyo", ["133.83.241.26", "133.19.37.224", "133.16.225.16"]],
  ["JP", "Yokohama", "14", "Asia/Tokyo", ["153.168.26.115", "153.246.23.2", "153.209.190.47"]],
  ["FR", "Paris", "IDF", "Europe/Paris", ["90.16.25.133", "90.127.156.218", "90.92.201.208"]],
  ["FR", "Lyon", "ARA", "Europe/Paris", ["90.66.213.38", "90.65.164.54", "90.119.184.226"]],
  ["FR", "Rennes", "BRE", "Europe/Paris", ["90.80.20.30", "90.86.8.30", "90.16.215.203"]],
  ["FR", "Marseille", "PAC", "Europe/Paris", ["90.8.56.163", "90.73.160.68", "90.37.181.90"]],
  ["FR", "Toulouse", "OCC", "Europe/Paris", ["90.1.208.157", "90.76.202.36", "86.249.228.173"]],
  ["FR", "Strasbourg", "GES", "Europe/Paris", ["90.19.218.233", "90.80.247.83", "90.33.98.208"]],
  ["CA", "Toronto", "ON", "America/Toronto", ["99.231.81.216", "99.239.79.90", "99.230.101.136"]],
  ["CA", "Montreal", "QC", "America/Toronto", ["70.26.200.120", "70.31.225.121", "70.29.192.111"]],
  ["CA", "Mississauga", "ON", "America/Toronto", ["99.246.189.29", "99.247.25.240", "99.233.20.212"]],
  ["CA", "Calgary", "AB", "America/Edmonton", ["70.28.245.99", "24.66.102.68", "24.64.46.74"]],
  ["AU", "Melbourne", "VIC", "Australia/Melbourne", ["1.145.164.10", "1.152.123.177", "1.159.78.236"]],
  ["AU", "Sydney", "NSW", "Australia/Sydney", ["1.130.177.222", "1.157.142.39", "1.156.6.134"]],
  ["AU", "Brisbane", "QLD", "Australia/Brisbane", ["1.146.46.90", "1.128.79.148", "1.132.47.142"]],
  ["AU", "Adelaide", "SA", "Australia/Adelaide", ["1.143.183.238", "1.158.129.16", "1.147.76.111"]],
  ["AU", "Perth", "WA", "Australia/Perth", ["1.159.217.70", "1.146.243.119", "1.143.217.186"]],
  ["AU", "Canberra", "ACT", "Australia/Sydney", ["1.157.93.173", "101.167.234.213", "101.178.210.171"]],
  ["NL", "Amsterdam", "NH", "Europe/Amsterdam", ["77.170.89.84", "77.173.16.99", "77.171.85.15"]],
  ["NL", "The Hague", "ZH", "Europe/Amsterdam", ["77.175.33.42", "77.168.107.222", "77.174.22.40"]],
  ["NL", "Rotterdam", "ZH", "Europe/Amsterdam", ["77.172.126.139", "77.171.95.128", "77.160.204.66"]],
  ["NL", "Groningen", "GR", "Europe/Amsterdam", ["77.171.193.77", "77.172.201.157", "94.213.112.48"]],
  ["NL", "Breda", "NB", "Europe/Amsterdam", ["77.173.214.40", "94.215.134.255", "94.214.99.162"]],
  ["NL", "Tilburg", "NB", "Europe/Amsterdam", ["77.172.53.89", "77.175.150.219", "94.208.41.190"]],
  ["ES", "Madrid", "MD", "Europe/Madrid", ["88.27.226.111", "88.31.12.23", "88.26.4.141"]],
  ["ES", "Barcelona", "CT", "Europe/Madrid", ["88.2.62.247", "88.28.59.15", "88.12.44.52"]],
  ["ES", "Palma", "IB", "Europe/Madrid", ["88.20.78.171", "88.21.129.142", "88.2.134.141"]],
  ["ES", "Valencia", "VC", "Europe/Madrid", ["88.21.146.135", "88.19.67.17", "88.22.65.16"]],
  ["ES", "Zaragoza", "AR", "Europe/Madrid", ["88.6.133.244", "88.5.43.60", "88.4.216.65"]],
  ["ES", "Málaga", "AN", "Europe/Madrid", ["88.27.255.97", "88.29.241.235", "83.60.147.57"]],
  ["IT", "Rome", "62", "Europe/Rome", ["93.40.126.190", "93.61.182.116", "93.63.85.151"]],
  ["IT", "Milan", "25", "Europe/Rome", ["93.35.179.244", "93.46.223.40", "93.50.22.225"]],
  ["IT", "Naples", "72", "Europe/Rome", ["93.36.198.47", "93.56.142.221", "93.35.196.197"]],
  ["IT", "Florence", "52", "Europe/Rome", ["93.51.211.2", "93.47.249.44", "93.62.140.156"]],
  ["IT", "Bologna", "45", "Europe/Rome", ["93.49.102.66", "93.45.40.49", "93.34.103.140"]],
  ["IT", "Turin", "21", "Europe/Rome", ["93.43.253.159", "93.39.135.154", "93.32.154.80"]],
  ["MX", "Puebla City", "PUE", "America/Mexico_City", ["187.212.36.118", "187.157.208.219", "187.142.202.75"]],
  ["MX", "Monterrey", "NLE", "America/Monterrey", ["187.160.220.59", "187.162.46.239", "187.191.3.186"]],
  ["MX", "Guadalajara", "JAL", "America/Mexico_City", ["187.216.149.255", "187.211.31.162", "187.247.160.167"]],
  ["MX", "Tijuana", "BCN", "America/Tijuana", ["187.189.37.108", "187.250.171.52", "189.196.82.241"]],
  ["MX", "Mérida", "YUC", "America/Merida", ["187.147.240.61", "187.207.202.183", "187.249.191.176"]],
  ["ID", "East Jakarta", "JK", "Asia/Jakarta", ["36.70.104.32", "36.84.177.217", "36.68.84.64"]],
  ["ID", "Surabaya", "JI", "Asia/Jakarta", ["36.81.132.201", "36.79.119.178", "36.82.76.44"]],
  ["ID", "Makassar", "SN", "Asia/Makassar", ["36.79.128.58", "36.90.151.106", "182.7.27.165"]],
  ["ID", "West Jakarta", "JK", "Asia/Jakarta", ["36.93.93.207", "36.92.66.88", "36.77.244.144"]],
  ["ID", "Denpasar", "BA", "Asia/Makassar", ["36.75.97.158", "36.82.170.97", "36.65.129.54"]],
  ["ID", "Malang", "JI", "Asia/Jakarta", ["36.79.246.161", "36.85.82.225", "36.72.219.117"]],
  ["NG", "Lagos", "LA", "Africa/Lagos", ["105.113.136.14", "105.127.10.175", "105.114.26.129"]],
  ["NG", "Abuja", "FC", "Africa/Lagos", ["105.117.57.115", "105.112.224.5", "197.210.74.48"]],
  ["NG", "Kano", "KN", "Africa/Lagos", ["105.120.70.35", "105.113.19.8"]],
  ["NG", "Ibadan", "OY", "Africa/Lagos", ["105.119.127.237", "41.217.57.186"]],
  ["NG", "Port Harcourt", "RI", "Africa/Lagos", ["105.116.3.189", "105.113.41.245", "102.90.90.166"]],
  ["ZA", "Johannesburg", "GP", "Africa/Johannesburg", ["41.112.34.201", "41.123.142.136", "41.145.193.14"]],
  ["ZA", "Cape Town", "WC", "Africa/Johannesburg", ["41.157.165.21", "41.121.210.209", "41.164.226.58"]],
  ["ZA", "Durban", "KZN", "Africa/Johannesburg", ["41.13.176.187", "41.25.145.102", "41.114.219.158"]],
  ["ZA", "Pretoria", "GP", "Africa/Johannesburg", ["41.124.235.38", "41.135.114.120", "41.18.153.68"]],
  ["ZA", "Bloemfontein", "FS", "Africa/Johannesburg", ["105.185.30.55", "196.254.151.182", "196.26.233.76"]],
  ["KR", "Seoul", "11", "Asia/Seoul", ["211.219.125.47", "211.206.229.215", "211.217.154.106"]],
  ["KR", "Suwon", "41", "Asia/Seoul", ["211.184.107.157", "211.195.100.41", "211.58.197.178"]],
  ["KR", "Busan", "26", "Asia/Seoul", ["211.203.89.224", "211.184.169.199", "211.207.51.6"]],
  ["KR", "Yongin-si", "41", "Asia/Seoul", ["211.226.0.180", "211.243.124.207", "211.198.53.75"]],
  ["KR", "Cheonan", "44", "Asia/Seoul", ["211.247.84.150", "211.170.175.61", "121.156.229.217"]],
  ["SE", "Stockholm", "AB", "Europe/Stockholm", ["78.71.155.54", "78.108.11.240", "78.75.187.45"]],
  ["SE", "Malmö", "M", "Europe/Stockholm", ["78.69.22.105", "78.67.201.102", "78.68.221.23"]],
  ["SE", "Uppsala", "C", "Europe/Stockholm", ["78.72.35.61", "78.64.72.35", "81.224.107.11"]],
  ["SE", "Gothenburg", "O", "Europe/Stockholm", ["78.70.193.118", "78.67.41.220", "78.82.1.20"]],
  ["SE", "Kalmar", "H", "Europe/Stockholm", ["78.65.154.162", "78.69.81.189", "81.230.222.192"]],
  ["PL", "Warsaw", "14", "Europe/Warsaw", ["83.19.29.90", "83.5.163.55", "83.3.50.64"]],
  ["PL", "Krakow", "12", "Europe/Warsaw", ["83.10.40.97", "89.64.60.117", "89.79.219.13"]],
  ["PL", "Gdansk", "22", "Europe/Warsaw", ["83.8.63.27", "89.69.211.39", "89.65.35.164"]],
  ["PL", "Katowice", "24", "Europe/Warsaw", ["83.22.25.155", "83.18.226.77", "83.10.114.97"]],
  ["PL", "Wroclaw", "02", "Europe/Warsaw", ["83.4.4.104", "83.10.225.163", "83.27.117.62"]],
  ["TR", "Istanbul", "34", "Europe/Istanbul", ["78.184.15.98", "78.188.5.235", "78.171.218.123"]],
  ["TR", "Ankara", "06", "Europe/Istanbul", ["78.166.146.81", "78.184.95.44", "78.175.129.239"]],
  ["TR", "Izmir", "35", "Europe/Istanbul", ["78.185.236.117", "78.173.130.84", "78.180.28.1"]],
  ["TR", "Bursa", "16", "Europe/Istanbul", ["78.189.131.42", "78.186.173.98", "78.174.193.125"]],
  ["SG", "Singapore", "", "Asia/Singapore", ["116.87.133.21", "116.86.146.198", "101.127.252.200"]],
  ["AE", "Dubai", "DU", "Asia/Dubai", ["5.30.238.186", "5.31.17.64", "94.207.92.189"]],
  ["AE", "Abu Dhabi", "AZ", "Asia/Dubai", ["5.31.212.94", "94.202.194.35", "94.205.166.239"]],
  ["AE", "Sharjah", "SH", "Asia/Dubai", ["5.31.42.170", "5.30.58.113", "94.202.235.102"]],
  ["AR", "Buenos Aires", "C", "America/Argentina/Buenos_Aires", ["181.46.243.110", "181.15.34.168", "181.9.18.62"]],
  ["AR", "La Plata", "B", "America/Argentina/Buenos_Aires", ["181.25.125.239", "181.230.95.224", "181.164.118.50"]],
  ["AR", "Córdoba", "X", "America/Argentina/Cordoba", ["181.167.137.229", "181.94.203.40", "181.0.164.4"]],
  ["AR", "Rosario", "S", "America/Argentina/Cordoba", ["181.168.130.235", "181.7.43.38", "181.94.157.6"]],
  ["CH", "Zurich", "ZH", "Europe/Zurich", ["178.197.59.118", "178.196.184.114", "178.195.161.55"]],
  ["CH", "Lausanne", "VD", "Europe/Zurich", ["178.199.197.80", "178.198.145.253", "178.194.219.49"]],
  ["CH", "Bern", "BE", "Europe/Zurich", ["178.193.150.246", "178.199.26.26", "85.2.136.234"]],
  ["CH", "Geneva", "GE", "Europe/Zurich", ["178.194.100.221", "178.195.9.24", "85.5.154.83"]],
  ["PH", "Makati City", "00", "Asia/Manila", ["120.28.10.150", "112.199.24.98", "180.191.246.114"]],
  ["PH", "Cagayan de Oro", "10", "Asia/Manila", ["120.28.204.123", "49.146.47.99", "49.149.44.178"]],
  ["PH", "Davao City", "11", "Asia/Manila", ["120.28.197.189", "49.145.215.9", "49.149.79.238"]],
  ["PH", "Cebu City", "07", "Asia/Manila", ["49.145.39.143", "49.148.15.215", "49.146.240.38"]],
  ["VN", "Ho Chi Minh City", "SG", "Asia/Ho_Chi_Minh", ["14.168.57.95", "14.185.83.146", "14.169.203.232"]],
  ["VN", "Hanoi", "HN", "Asia/Bangkok", ["14.162.137.178", "14.181.29.155", "14.188.214.198"]],
];

// country -> { weight, mobile share, speed factor (slower networks > 1), languages, google domain }
const COUNTRIES = {
  US: { w: 24, mobile: 0.5, speed: 1.0, ios: 0.55, langs: [[1, "en-US"]], google: "www.google.com" },
  IN: { w: 12, mobile: 0.8, speed: 1.35, ios: 0.1, langs: [[6, "en-IN"], [2, "hi-IN"], [1, "en-US"]], google: "www.google.co.in" },
  DE: { w: 8, mobile: 0.42, speed: 0.9, ios: 0.4, langs: [[8, "de-DE"], [2, "en-US"]], google: "www.google.de" },
  GB: { w: 8, mobile: 0.52, speed: 0.95, ios: 0.5, langs: [[1, "en-GB"]], google: "www.google.co.uk" },
  BR: { w: 6, mobile: 0.7, speed: 1.2, ios: 0.2, langs: [[9, "pt-BR"], [1, "en-US"]], google: "www.google.com.br" },
  FR: { w: 5, mobile: 0.5, speed: 0.95, ios: 0.4, langs: [[9, "fr-FR"], [1, "en-GB"]], google: "www.google.fr" },
  CA: { w: 4, mobile: 0.5, speed: 1.0, ios: 0.5, langs: [[7, "en-CA"], [2, "fr-CA"], [1, "en-US"]], google: "www.google.ca" },
  JP: { w: 4, mobile: 0.55, speed: 0.8, ios: 0.6, langs: [[9, "ja-JP"], [1, "en-US"]], google: "www.google.co.jp" },
  AU: { w: 3, mobile: 0.5, speed: 1.0, ios: 0.55, langs: [[1, "en-AU"]], google: "www.google.com.au" },
  NL: { w: 3, mobile: 0.45, speed: 0.85, ios: 0.45, langs: [[7, "nl-NL"], [3, "en-US"]], google: "www.google.nl" },
  ES: { w: 3, mobile: 0.55, speed: 1.0, ios: 0.3, langs: [[8, "es-ES"], [2, "ca-ES"], [1, "en-US"]], google: "www.google.es" },
  IT: { w: 3, mobile: 0.55, speed: 1.05, ios: 0.3, langs: [[9, "it-IT"], [1, "en-US"]], google: "www.google.it" },
  MX: { w: 3, mobile: 0.72, speed: 1.15, ios: 0.25, langs: [[9, "es-MX"], [1, "en-US"]], google: "www.google.com.mx" },
  ID: { w: 3, mobile: 0.82, speed: 1.4, ios: 0.1, langs: [[8, "id-ID"], [2, "en-US"]], google: "www.google.co.id" },
  PL: { w: 2, mobile: 0.5, speed: 0.95, ios: 0.25, langs: [[9, "pl-PL"], [1, "en-GB"]], google: "www.google.pl" },
  TR: { w: 2, mobile: 0.65, speed: 1.1, ios: 0.2, langs: [[9, "tr-TR"], [1, "en-US"]], google: "www.google.com.tr" },
  SE: { w: 2, mobile: 0.45, speed: 0.8, ios: 0.55, langs: [[7, "sv-SE"], [3, "en-US"]], google: "www.google.se" },
  KR: { w: 2, mobile: 0.55, speed: 0.8, ios: 0.3, langs: [[1, "ko-KR"]], google: "www.google.co.kr" },
  NG: { w: 1.5, mobile: 0.85, speed: 1.6, ios: 0.08, langs: [[1, "en-NG"]], google: "www.google.com.ng" },
  ZA: { w: 1.5, mobile: 0.65, speed: 1.3, ios: 0.2, langs: [[7, "en-ZA"], [1, "af-ZA"]], google: "www.google.co.za" },
  SG: { w: 1.5, mobile: 0.5, speed: 0.8, ios: 0.5, langs: [[7, "en-SG"], [2, "zh-SG"]], google: "www.google.com.sg" },
  AE: { w: 1, mobile: 0.6, speed: 1.0, ios: 0.5, langs: [[6, "en-AE"], [4, "ar-AE"]], google: "www.google.ae" },
  AR: { w: 1, mobile: 0.65, speed: 1.2, ios: 0.2, langs: [[1, "es-AR"]], google: "www.google.com.ar" },
  CH: { w: 1, mobile: 0.45, speed: 0.85, ios: 0.5, langs: [[6, "de-CH"], [2, "fr-CH"], [2, "en-US"]], google: "www.google.ch" },
  PH: { w: 1, mobile: 0.8, speed: 1.3, ios: 0.15, langs: [[1, "en-PH"]], google: "www.google.com.ph" },
  VN: { w: 1, mobile: 0.75, speed: 1.2, ios: 0.2, langs: [[8, "vi-VN"], [2, "en-US"]], google: "www.google.com.vn" },
};

const CITIES = new Map(); // country -> [{city, region, tz, ips}]
for (const [cc, city, region, tz, ips] of GEO_ROWS) {
  if (!CITIES.has(cc)) CITIES.set(cc, []);
  CITIES.get(cc).push({ cc, city, region, tz, ips });
}
for (const cc of Object.keys(COUNTRIES)) {
  if (!CITIES.has(cc)) throw new Error(`No geo rows for ${cc}`);
}

// Datacenter / crawler IPs for bot traffic (country/ASN verified with --check-geo)
const BOT_IPS = {
  googlebot: ["66.249.66.1", "66.249.66.12"],
  bingbot: ["40.77.167.10", "207.46.13.10"],
  aws: ["52.15.100.20", "18.205.1.5", "3.120.10.10", "13.52.10.2"],
  hetzner: ["5.9.100.30", "95.216.10.10"],
  digitalocean: ["159.65.10.20", "138.68.50.20", "167.99.10.2", "104.248.10.5"],
  ovh: ["54.36.148.1", "51.15.20.30"],
  gcp: ["34.74.10.5", "35.190.0.10"],
  azure: ["20.171.206.10", "40.77.167.10"],
  contabo: ["194.163.140.10"],
};

// ---------------------------------------------------------------------------
// User agents. `browser`/`os` are what ua-parser-js (the server's parser) reports;
// they are used for the historical import, which stores names rather than UAs.
// Versions stay far above the server's stale-browser cutoff (70) and are limited to
// two builds per browser so no cohort looks like a rotating-UA fleet.
// ---------------------------------------------------------------------------

const CH = ["141.0.0.0", "142.0.0.0"];
const UAS = {
  desktop: [
    { w: 30, browser: "Chrome", os: "Windows", ua: v => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`, v: CH },
    { w: 8, browser: "Edge", os: "Windows", ua: v => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36 Edg/${v}`, v: CH },
    { w: 5, browser: "Firefox", os: "Windows", ua: v => `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}) Gecko/20100101 Firefox/${v}`, v: ["143.0", "144.0"] },
    { w: 9, browser: "Chrome", os: "macOS", ua: v => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`, v: CH },
    { w: 8, browser: "Safari", os: "macOS", ua: v => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v} Safari/605.1.15`, v: ["18.5", "18.6"] },
    { w: 3, browser: "Firefox", os: "macOS", ua: v => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${v}) Gecko/20100101 Firefox/${v}`, v: ["143.0", "144.0"] },
    { w: 4, browser: "Chrome", os: "Linux", ua: v => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`, v: CH },
    { w: 3, browser: "Firefox", os: "Ubuntu", ua: v => `Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:${v}) Gecko/20100101 Firefox/${v}`, v: ["143.0", "144.0"] },
  ],
  mobileAndroid: [
    { w: 70, browser: "Mobile Chrome", os: "Android", ua: v => `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Mobile Safari/537.36`, v: CH },
    { w: 14, browser: "Mobile Chrome", os: "Android", ua: v => `Mozilla/5.0 (Linux; Android 13; Redmi Note 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Mobile Safari/537.36`, v: CH },
    { w: 22, browser: "Samsung Internet", os: "Android", ua: v => `Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/${v} Chrome/130.0.0.0 Mobile Safari/537.36`, v: ["27.0", "28.0"] },
    { w: 5, browser: "Mobile Firefox", os: "Android", ua: v => `Mozilla/5.0 (Android 14; Mobile; rv:${v}) Gecko/${v} Firefox/${v}`, v: ["143.0", "144.0"] },
  ],
  mobileIos: [
    { w: 85, browser: "Mobile Safari", os: "iOS", ua: v => `Mozilla/5.0 (iPhone; CPU iPhone OS ${v.replace(".", "_")} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v} Mobile/15E148 Safari/604.1`, v: ["18.5", "18.6"] },
    { w: 12, browser: "Mobile Chrome", os: "iOS", ua: v => `Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${v} Mobile/15E148 Safari/604.1`, v: CH.map(x => x.replace(".0.0.0", ".0.7339.101")) },
    { w: 3, browser: "Mobile Firefox", os: "iOS", ua: v => `Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/${v} Mobile/15E148 Safari/605.1.15`, v: ["143.0", "144.0"] },
  ],
  tabletIos: [
    { w: 1, browser: "Mobile Safari", os: "iOS", ua: v => `Mozilla/5.0 (iPad; CPU OS ${v.replace(".", "_")} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v} Mobile/15E148 Safari/604.1`, v: ["18.5", "18.6"] },
  ],
  tabletAndroid: [
    { w: 1, browser: "Chrome", os: "Android", ua: v => `Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`, v: CH },
  ],
};
const SCREENS = {
  desktop: [[28, 1920, 1080], [18, 1536, 864], [12, 1440, 900], [10, 2560, 1440], [9, 1366, 768], [6, 1680, 1050], [4, 3840, 2160], [8, 1728, 1117], [5, 1512, 982]],
  mobile: [[22, 390, 844], [20, 393, 852], [20, 412, 915], [16, 360, 800], [10, 414, 896], [6, 375, 667], [6, 360, 780]],
  tablet: [[40, 820, 1180], [25, 768, 1024], [20, 810, 1080], [15, 800, 1280]],
};

// ---------------------------------------------------------------------------
// The fictional site
// ---------------------------------------------------------------------------

const PAGES = {
  "/": { title: "Lumenly - Privacy-friendly product analytics", dwell: 28 },
  "/pricing": { title: "Pricing - Lumenly", dwell: 55 },
  "/features": { title: "Features - Lumenly", dwell: 45 },
  "/features/analytics": { title: "Web analytics - Lumenly", dwell: 50 },
  "/features/session-replay": { title: "Session replay - Lumenly", dwell: 55 },
  "/blog": { title: "Blog - Lumenly", dwell: 30 },
  "/blog/privacy-first-analytics": { title: "Why privacy-first analytics wins - Lumenly Blog", dwell: 140 },
  "/blog/reduce-bounce-rate": { title: "9 ways to reduce your bounce rate - Lumenly Blog", dwell: 150 },
  "/blog/ga4-alternatives": { title: "The best GA4 alternatives in 2026 - Lumenly Blog", dwell: 160 },
  "/docs": { title: "Documentation - Lumenly", dwell: 30 },
  "/docs/quickstart": { title: "Quickstart - Lumenly Docs", dwell: 110 },
  "/docs/api": { title: "API reference - Lumenly Docs", dwell: 120 },
  "/docs/self-hosting": { title: "Self-hosting guide - Lumenly Docs", dwell: 130 },
  "/signup": { title: "Create your account - Lumenly", dwell: 70 },
  "/login": { title: "Log in - Lumenly", dwell: 20 },
  "/welcome": { title: "Welcome to Lumenly", dwell: 45 },
  "/contact": { title: "Contact sales - Lumenly", dwell: 60 },
  "/about": { title: "About us - Lumenly", dwell: 35 },
  "/changelog": { title: "Changelog - Lumenly", dwell: 60 },
  "/customers": { title: "Customer stories - Lumenly", dwell: 50 },
};

// next-page transitions: [weight, path]; an "exit" is the remaining probability mass
const NEXT = {
  "/": [[26, "/pricing"], [22, "/features"], [10, "/blog"], [9, "/docs"], [10, "/signup"], [5, "/about"], [4, "/customers"], [3, "/login"]],
  "/pricing": [[38, "/signup"], [14, "/features"], [9, "/contact"], [8, "/docs"], [6, "/customers"], [5, "/"]],
  "/features": [[24, "/features/analytics"], [14, "/features/session-replay"], [22, "/pricing"], [8, "/signup"], [6, "/docs"]],
  "/features/analytics": [[30, "/pricing"], [14, "/features/session-replay"], [10, "/docs/quickstart"], [8, "/signup"]],
  "/features/session-replay": [[30, "/pricing"], [14, "/features/analytics"], [8, "/signup"]],
  "/blog": [[30, "/blog/privacy-first-analytics"], [28, "/blog/ga4-alternatives"], [24, "/blog/reduce-bounce-rate"], [6, "/"]],
  "/blog/privacy-first-analytics": [[18, "/features"], [14, "/blog"], [12, "/pricing"], [8, "/blog/ga4-alternatives"], [6, "/"]],
  "/blog/reduce-bounce-rate": [[16, "/features/analytics"], [14, "/blog"], [10, "/pricing"], [6, "/"]],
  "/blog/ga4-alternatives": [[22, "/pricing"], [18, "/features"], [10, "/blog"], [10, "/"], [8, "/docs/self-hosting"]],
  "/docs": [[40, "/docs/quickstart"], [14, "/docs/api"], [12, "/docs/self-hosting"], [4, "/"]],
  "/docs/quickstart": [[22, "/docs/api"], [16, "/docs/self-hosting"], [14, "/signup"], [6, "/docs"]],
  "/docs/api": [[22, "/docs/quickstart"], [10, "/docs"], [6, "/pricing"]],
  "/docs/self-hosting": [[24, "/docs/quickstart"], [12, "/docs/api"], [8, "/signup"], [6, "/pricing"]],
  "/signup": [[64, "/welcome"], [8, "/login"], [6, "/pricing"]],
  "/login": [[50, "/welcome"], [8, "/signup"], [6, "/docs"]],
  "/welcome": [[48, "/docs/quickstart"], [14, "/docs/api"], [8, "/features"]],
  "/contact": [[20, "/pricing"], [10, "/"], [8, "/customers"]],
  "/about": [[26, "/customers"], [14, "/contact"], [14, "/pricing"], [10, "/"]],
  "/changelog": [[24, "/features"], [18, "/blog"], [14, "/docs"], [8, "/pricing"]],
  "/customers": [[30, "/pricing"], [16, "/contact"], [10, "/features"], [8, "/signup"]],
};

const OUTBOUND = {
  github: { url: "https://github.com/lumenly/lumenly-js", text: "Star us on GitHub" },
  status: { url: "https://status.lumenly.example/", text: "System status" },
  g2: { url: "https://www.g2.com/products/lumenly/reviews", text: "Read reviews on G2" },
  twitter: { url: "https://x.com/lumenly", text: "Follow @lumenly" },
  linkedin: { url: "https://www.linkedin.com/company/lumenly", text: "LinkedIn" },
  docker: { url: "https://hub.docker.com/r/lumenly/lumenly", text: "Docker image" },
  npm: { url: "https://www.npmjs.com/package/@lumenly/js", text: "npm package" },
  discord: { url: "https://discord.gg/lumenly-demo", text: "Join our Discord" },
};

const PLANS = [[6, "free"], [5, "starter"], [3, "pro"], [1, "enterprise"]];
const ERRORS = [
  { name: "TypeError", message: "Cannot read properties of undefined (reading 'map')", file: "/_next/static/chunks/pricing-3f9a.js" },
  { name: "TypeError", message: "Cannot read properties of null (reading 'addEventListener')", file: "/_next/static/chunks/app-1c2d.js" },
  { name: "ReferenceError", message: "gtag is not defined", file: "/static/js/vendor.js" },
  { name: "SyntaxError", message: "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON", file: "/_next/static/chunks/signup-77ab.js" },
  { name: "ChunkLoadError", message: "Loading chunk 482 failed.", file: "/_next/static/chunks/webpack.js" },
  { name: "NetworkError", message: "Failed to fetch /api/subscribe", file: "/_next/static/chunks/newsletter-90de.js" },
  { name: "RangeError", message: "Invalid array length", file: "/_next/static/chunks/charts-aa31.js" },
  { name: "TypeError", message: "Failed to execute 'observe' on 'IntersectionObserver': parameter 1 is not of type 'Element'", file: "/_next/static/chunks/app-1c2d.js" },
];
const SEARCH_QUERIES = ["self hosting", "api key", "custom events", "funnels", "docker compose", "web vitals", "cookie banner", "identify users", "retention", "gdpr"];
const COMPANIES = ["Acme GmbH", "Globex", "Initech", "Umbrella Labs", "Stark Analytics", "Wayne Digital", "Hooli", "Pied Piper", "Soylent Co", "Vandelay Industries", "Tyrell Corp", "Cyberdyne Systems"];
const FIRST = ["Alex", "Sam", "Priya", "Lars", "Mei", "Carlos", "Amara", "Yuki", "Fatima", "Noah", "Emma", "Ravi", "Chloe", "Mateo", "Sofia", "Hans", "Olu", "Ines", "Jin", "Aisha"];
const LAST = ["Smith", "Patel", "Müller", "Silva", "Tanaka", "Dubois", "Kowalski", "Okafor", "Nguyen", "Garcia", "Rossi", "Andersson", "Kim", "Brown", "Haddad", "Jansen"];

// ---------------------------------------------------------------------------
// Acquisition sources
// ---------------------------------------------------------------------------

const campaigns = {
  newsletter: ["product-update-nov", "weekly-digest", "launch-v2-announcement", "q4-case-studies"],
  google_cpc: ["brand-search", "competitor-alternatives", "analytics-generic"],
  twitter_paid: ["launch-v2", "retargeting-nov"],
  linkedin_paid: ["b2b-webinar", "ebook-privacy"],
  producthunt: ["launch-day"],
};

// [weight, id]
const SOURCES = [
  [27, "direct"], [22, "google"], [4, "bing"], [3, "duckduckgo"], [4, "twitter"], [4, "reddit"], [5, "linkedin"],
  [3, "facebook"], [4, "hackernews"], [4, "github"], [2, "youtube"], [5, "newsletter"], [3, "google_cpc"],
  [1.5, "twitter_paid"], [1.5, "linkedin_paid"], [1, "producthunt"], [1.5, "chatgpt"], [1, "perplexity"], [1, "medium"],
];

function buildEntry(sourceId, country) {
  const c = COUNTRIES[country];
  let referrer = "";
  let qs = "";
  let landing = pickW([[10, "/"], [4, "/pricing"], [3, "/features"], [2, "/blog"], [2, "/docs"]], x => x[0])[1];
  const utm = (s, m, camp, extra = "") => `?utm_source=${s}&utm_medium=${m}&utm_campaign=${camp}${extra}`;
  switch (sourceId) {
    case "google":
      referrer = `https://${c.google}/`;
      landing = pickW([[10, "/"], [8, "/blog/ga4-alternatives"], [5, "/blog/privacy-first-analytics"], [4, "/blog/reduce-bounce-rate"], [5, "/features"], [4, "/docs/self-hosting"], [3, "/pricing"]], x => x[0])[1];
      break;
    case "bing":
      referrer = "https://www.bing.com/";
      landing = pickW([[8, "/"], [4, "/blog/ga4-alternatives"], [3, "/features"]], x => x[0])[1];
      break;
    case "duckduckgo":
      referrer = "https://duckduckgo.com/";
      landing = pickW([[6, "/"], [5, "/blog/privacy-first-analytics"], [3, "/docs/self-hosting"]], x => x[0])[1];
      break;
    case "twitter":
      referrer = "https://t.co/" + hex(10);
      landing = pickW([[6, "/blog/privacy-first-analytics"], [4, "/"], [3, "/changelog"]], x => x[0])[1];
      break;
    case "reddit":
      referrer = pick(["https://www.reddit.com/r/selfhosted/", "https://www.reddit.com/r/webdev/", "https://www.reddit.com/r/privacy/", "https://old.reddit.com/r/SaaS/"]);
      landing = pickW([[5, "/blog/ga4-alternatives"], [4, "/docs/self-hosting"], [3, "/"]], x => x[0])[1];
      break;
    case "linkedin":
      referrer = "https://www.linkedin.com/";
      landing = pickW([[5, "/blog/reduce-bounce-rate"], [4, "/customers"], [3, "/"]], x => x[0])[1];
      break;
    case "facebook":
      referrer = pick(["https://l.facebook.com/", "https://m.facebook.com/"]);
      landing = pickW([[5, "/"], [3, "/blog/reduce-bounce-rate"]], x => x[0])[1];
      break;
    case "hackernews":
      referrer = "https://news.ycombinator.com/";
      landing = pickW([[6, "/blog/privacy-first-analytics"], [4, "/docs/self-hosting"], [3, "/"]], x => x[0])[1];
      break;
    case "github":
      referrer = pick(["https://github.com/", "https://github.com/lumenly/lumenly-js"]);
      landing = pickW([[6, "/docs/quickstart"], [4, "/docs/self-hosting"], [3, "/"]], x => x[0])[1];
      break;
    case "youtube":
      referrer = "https://www.youtube.com/";
      landing = pickW([[5, "/"], [3, "/features/session-replay"]], x => x[0])[1];
      break;
    case "newsletter": {
      const camp = pick(campaigns.newsletter);
      qs = utm("newsletter", "email", camp, chance(0.5) ? `&utm_content=${pick(["cta-button", "header-link", "footer-link"])}` : "");
      landing = pickW([[5, "/changelog"], [4, "/blog/reduce-bounce-rate"], [3, "/"], [3, "/pricing"]], x => x[0])[1];
      break;
    }
    case "google_cpc":
      qs = utm("google", "cpc", pick(campaigns.google_cpc), `&utm_term=${pick(["privacy+analytics", "ga4+alternative", "cookieless+analytics", "web+analytics+tool"])}${chance(0.6) ? "&gclid=" + hex(16) : ""}`);
      referrer = `https://${c.google}/`;
      landing = pickW([[6, "/pricing"], [5, "/features"], [4, "/"]], x => x[0])[1];
      break;
    case "twitter_paid":
      qs = utm("twitter", "paid_social", pick(campaigns.twitter_paid));
      referrer = "https://t.co/" + hex(10);
      landing = pickW([[5, "/"], [4, "/pricing"]], x => x[0])[1];
      break;
    case "linkedin_paid":
      qs = utm("linkedin", "paid_social", pick(campaigns.linkedin_paid));
      referrer = "https://www.linkedin.com/";
      landing = pickW([[5, "/customers"], [4, "/pricing"], [3, "/contact"]], x => x[0])[1];
      break;
    case "producthunt":
      qs = utm("producthunt", "referral", pick(campaigns.producthunt));
      referrer = "https://www.producthunt.com/";
      landing = "/";
      break;
    case "chatgpt":
      referrer = "https://chatgpt.com/";
      landing = pickW([[5, "/blog/ga4-alternatives"], [3, "/features"], [2, "/docs/self-hosting"]], x => x[0])[1];
      break;
    case "perplexity":
      referrer = "https://www.perplexity.ai/";
      landing = pickW([[5, "/blog/ga4-alternatives"], [3, "/features"]], x => x[0])[1];
      break;
    case "medium":
      referrer = "https://medium.com/";
      landing = pickW([[4, "/blog/privacy-first-analytics"], [3, "/"]], x => x[0])[1];
      break;
    default:
      break; // direct
  }
  return { sourceId, referrer, qs, landing };
}

// ---------------------------------------------------------------------------
// Time of day by country timezone
// ---------------------------------------------------------------------------

const HOUR_W = [0.5, 0.3, 0.2, 0.2, 0.3, 0.6, 1.2, 2.4, 4.2, 6, 7, 7, 6.2, 6.4, 7, 7, 6.5, 5.5, 4.6, 4.4, 5, 4.4, 2.8, 1.4];
const tzOffsetCache = new Map();
/** Offset (minutes east of UTC) of `tz` at the given instant. */
function tzOffsetMin(tz, atMs) {
  const hourKey = `${tz}|${Math.floor(atMs / 3_600_000)}`;
  if (tzOffsetCache.has(hourKey)) return tzOffsetCache.get(hourKey);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(atMs));
  const g = t => Number(parts.find(p => p.type === t).value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  const off = Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / MIN);
  tzOffsetCache.set(hourKey, off);
  return off;
}

// ---------------------------------------------------------------------------
// Visitors
// ---------------------------------------------------------------------------

const NOW = Date.now();
const TODAY_START = Math.floor(NOW / DAY) * DAY;
const BACKFILL_ENABLED = !!CFG.apiKey && !CFG.noBackfill && /^\d+$/.test(CFG.siteId) && CFG.days > 1;
const numericSiteId = /^\d+$/.test(CFG.siteId) ? Number(CFG.siteId) : null;

function pickDevice(country) {
  const c = COUNTRIES[country];
  const r = rng();
  let cls;
  let family;
  if (r < 0.05) {
    cls = "tablet";
    family = chance(c.ios + 0.2) ? "tabletIos" : "tabletAndroid";
  } else if (r < 0.05 + c.mobile) {
    cls = "mobile";
    family = chance(c.ios) ? "mobileIos" : "mobileAndroid";
  } else {
    cls = "desktop";
    family = "desktop";
  }
  const prof = pickW(UAS[family], x => x.w);
  const version = pick(prof.v);
  const [, sw, sh] = pickW(SCREENS[cls], x => x[0]);
  return { cls, prof, userAgent: prof.ua(version), screenWidth: sw, screenHeight: sh };
}

let visitorSeq = 0;
function makeVisitor() {
  const country = pickW(Object.entries(COUNTRIES), x => x[1].w)[0];
  const place = pick(CITIES.get(country));
  const dev = pickDevice(country);
  const lang = pickW(COUNTRIES[country].langs)[1];
  const anonId = `demo-${hex(20)}`;
  return {
    n: ++visitorSeq,
    anonId,
    country,
    place,
    ip: pick(place.ips), // exact verified IPs: --check-geo shows even a /24 neighbour can geolocate elsewhere
    dev,
    language: lang,
    speed: COUNTRIES[country].speed * (dev.cls === "mobile" ? 1.3 : 1) * lognormal(1, 0.25),
    buyer: chance(0.07),
    userId: null, // set once the visitor signs up
    traits: null,
    visits: [], // [{daysAgo}]
    bot: false,
  };
}

/** Distance in days of a visitor's first visit, weighted towards recent days and weekdays. */
function sampleDaysAgo(maxDays) {
  const items = [];
  for (let d = 1; d <= maxDays - 1; d++) {
    const dow = new Date(TODAY_START - d * DAY).getUTCDay();
    const weekend = dow === 0 || dow === 6 ? 0.6 : 1;
    items.push([(1 - d / (maxDays * 1.8)) * weekend, d]);
  }
  return pickW(items)[1];
}

function planVisitors() {
  const list = [];
  const daysWindow = BACKFILL_ENABLED ? CFG.days : 1;
  for (let i = 0; i < CFG.visitors; i++) {
    const v = makeVisitor();
    const today = i < CFG.rich || !BACKFILL_ENABLED;
    const first = today ? 0 : sampleDaysAgo(daysWindow);
    v.visits.push({ daysAgo: first });
    // Returning visitors: ~25% come back on later days, some of them regularly.
    if (BACKFILL_ENABLED) {
      const returning = today ? chance(0.25) : chance(0.25);
      if (returning) {
        const loyal = chance(0.2);
        const offsets = loyal ? [1, 2, 3, 7, 8, 14, 15, 21, 28] : [1, 2, 3, 5, 7, 8, 14, 21];
        const count = loyal ? randInt(2, 5) : randInt(1, 3);
        const chosen = new Set();
        for (let k = 0; k < count; k++) {
          const o = offsets[Math.min(offsets.length - 1, Math.floor(Math.abs(gauss()) * 2.2))];
          chosen.add(o);
        }
        // A "today" visitor that returns is modelled as a visitor that was first seen earlier.
        if (today && first === 0) {
          const back = randInt(2, Math.max(2, Math.min(CFG.days - 1, 21)));
          v.visits.unshift({ daysAgo: back });
          if (chance(0.4)) v.visits.unshift({ daysAgo: Math.min(CFG.days - 1, back + randInt(3, 9)) });
        } else {
          for (const o of chosen) {
            const d = first - o;
            if (d >= 0) v.visits.push({ daysAgo: d });
          }
        }
      }
    }
    v.visits.sort((a, b) => b.daysAgo - a.daysAgo);
    list.push(v);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Visit simulation -> ordered steps
// ---------------------------------------------------------------------------

/**
 * A step is one network call. `delay` is the pause (ms of simulated time) before it,
 * counted from the previous step. `type` is a track event type, or "identify".
 */
function simulateVisit(v, visit, ctx) {
  const steps = [];
  const returningVisitor = ctx.visitIndex > 0;
  const identified = !!v.userId;

  // Entry: returning visitors mostly come straight back, customers log in.
  let sourceId;
  if (returningVisitor) sourceId = chance(0.6) ? "direct" : pickW(SOURCES)[1];
  else sourceId = pickW(SOURCES)[1];
  const entry = buildEntry(sourceId, v.country);
  if (returningVisitor && identified && chance(0.55)) entry.landing = "/login";
  else if (returningVisitor && chance(0.3)) entry.landing = pick(["/changelog", "/blog", "/docs", "/pricing"]);

  const path = [entry.landing];
  // session length: ~35% bounce, otherwise geometric-ish
  let cur = entry.landing;
  const continueP = identified ? 0.8 : 0.66;
  if (!chance(0.35 + (sourceId === "direct" && !returningVisitor ? 0.05 : 0))) {
    while (path.length < 9 && chance(continueP - path.length * 0.04)) {
      const choices = NEXT[cur];
      if (!choices) break;
      const total = choices.reduce((s, x) => s + x[0], 0);
      // leave room for "exit"
      if (!chance(total / (total + 24))) break;
      cur = pickW(choices)[1];
      path.push(cur);
    }
  }

  // Ready buyers walk the whole funnel (/ -> /pricing -> /signup -> /welcome), some drop off on the way.
  if (v.buyer && !v.userId && !returningVisitor) {
    const drop = rng();
    const funnel = [entry.landing === "/pricing" ? null : entry.landing, "/pricing", "/signup", "/welcome", "/docs/quickstart"].filter(Boolean);
    path.length = 0;
    path.push(...funnel.slice(0, drop < 0.15 ? 2 : drop < 0.35 ? 3 : drop < 0.85 ? 4 : 5));
  }

  let prevUrl = "";
  let signedUp = false;
  // `uid` freezes who the visitor was when the step happened: a visitor identified halfway
  // through a visit must not carry the user id on the events before it.
  const push = (type, delay, fields, meta = {}) => steps.push({ type, delay: Math.max(0, Math.round(delay)), pathname: meta.pathname, fields, meta, uid: v.userId });

  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const page = PAGES[p];
    const isLanding = i === 0;
    const qs = isLanding ? entry.qs : p === "/docs" && chance(0.15) ? `?q=${encodeURIComponent(pick(SEARCH_QUERIES))}` : "";
    const dwellMs = clamp(lognormal(page.dwell, 0.7), 4, 900) * 1000;
    const referrer = isLanding ? entry.referrer : prevUrl;
    const base = { pathname: p, querystring: qs, page_title: page.title, referrer };
    const here = { pathname: p, querystring: qs, page_title: page.title };

    push("pageview", i === 0 ? 0 : ctx.lastDwell, base, { pathname: p, first: isLanding, source: sourceId });
    prevUrl = `https://${CFG.hostname}${p}${qs}`;
    let t = 0; // time inside the page so far; events are placed before `dwellMs`
    const at = (frac, minMs = 600) => Math.max(minMs, dwellMs * frac);
    const evt = (type, frac, eventName, props, extra = {}) => {
      const d = Math.max(400, at(frac) - t);
      t += d;
      push(type, d, { ...here, event_name: eventName, properties: props === undefined ? undefined : JSON.stringify(props), ...extra }, { pathname: p });
    };

    // Web vitals: ~75% of pageviews, shortly after load
    if (chance(0.75)) {
      const s = v.speed;
      const vitals = {
        lcp: Math.round(clamp(lognormal(1900 * s, 0.45), 300, 15000)),
        cls: chance(0.6) ? Math.round(clamp(lognormal(0.04, 1.1), 0, 1.5) * 1000) / 1000 : 0,
        inp: chance(0.55) ? Math.round(clamp(lognormal(140 * s, 0.6), 16, 2500)) : null,
        fcp: Math.round(clamp(lognormal(1100 * s, 0.4), 150, 9000)),
        ttfb: Math.round(clamp(lognormal(420 * s, 0.55), 40, 6000)),
      };
      const d = clamp(lognormal(2200, 0.4), 700, 6000);
      t += d;
      push("performance", d, { ...here, event_name: "web-vitals", ...vitals }, { pathname: p });
    }

    // JavaScript errors (more on the signup form and on slow connections)
    const errP = (p === "/signup" ? 0.07 : p === "/pricing" ? 0.035 : 0.02) * (v.speed > 1.25 ? 1.5 : 1);
    if (chance(errP)) {
      const e = pick(ERRORS);
      const lineNumber = randInt(1, 900);
      const columnNumber = randInt(1, 80);
      evt("error", 0.4, e.name, {
        message: e.message,
        stack: `${e.name}: ${e.message}\n    at render (https://${CFG.hostname}${e.file}:${lineNumber}:${columnNumber})\n    at commit (https://${CFG.hostname}/_next/static/chunks/framework.js:${randInt(1, 400)}:${randInt(1, 60)})`,
        fileName: `https://${CFG.hostname}${e.file}`,
        lineNumber,
        columnNumber,
      });
    }

    // Page specific behaviour
    if (p === "/" || p === "/pricing") {
      if (chance(p === "/" ? 0.2 : 0.3)) evt("button_click", 0.55, "", { text: p === "/" ? "Get started free" : "Start free trial", "data-rybbit-cta": p === "/" ? "hero" : "pricing" });
    }
    if (p === "/pricing") {
      if (chance(0.35)) evt("custom_event", 0.45, "pricing_toggle", { billing: pick(["annual", "monthly"]) });
      const wantsPlan = path[i + 1] === "/signup" || path[i + 1] === "/contact";
      if (wantsPlan || chance(0.08)) {
        const plan = pickW(PLANS)[1];
        evt("custom_event", 0.8, "plan_selected", { plan, billing: pick(["annual", "monthly"]), price: { free: 0, starter: 19, pro: 49, enterprise: 199 }[plan] });
        ctx.plan = plan;
      }
    }
    if (p.startsWith("/features") && chance(0.15)) evt("custom_event", 0.5, "video_played", { title: p === "/features/session-replay" ? "Session replay tour" : "Product walkthrough", percent: pick([25, 50, 100]) });
    if (p.startsWith("/docs")) {
      if (p === "/docs" && qs && chance(0.9)) evt("custom_event", 0.3, "docs_search", { query: decodeURIComponent(qs.slice(3)), results: randInt(0, 14) });
      if (p === "/docs/quickstart" && chance(0.35)) evt("copy", 0.6, "", { text: pick(["npm install @lumenly/js", "docker compose up -d", "<script src=\"https://analytics.example.com/api/script.js\" data-site-id=\"1\" defer></script>"]), sourceElement: "code" });
      if (p === "/docs/api" && chance(0.25)) evt("copy", 0.6, "", { text: "curl -H 'Authorization: Bearer $KEY' https://api.example.com/v1/sites", sourceElement: "pre" });
      if (p === "/docs/self-hosting" && chance(0.15)) evt("custom_event", 0.7, "file_downloaded", { file: "docker-compose.yml" });
    }
    if (p.startsWith("/blog/")) {
      if (chance(0.07)) evt("custom_event", 0.7, "newsletter_subscribed", { source: "blog-inline" });
      if (chance(0.1)) evt("copy", 0.5, "", { text: pick(["privacy-first analytics", "bounce rate is not a ranking factor", "no cookies, no consent banners"]), sourceElement: "p" });
    }
    if (p === "/customers" && chance(0.12)) evt("custom_event", 0.6, "case_study_opened", { company: pick(COMPANIES) });
    if (p === "/contact" && chance(0.4)) {
      evt("input_change", 0.4, "", { element: "input", inputType: "email", inputName: "work_email", formId: "contact-form", formName: "contact" });
      evt("form_submit", 0.85, "", { formId: "contact-form", formName: "contact", formAction: `https://${CFG.hostname}/contact`, method: "POST", fieldCount: 5 });
      evt("custom_event", 0.9, "demo_requested", { company_size: pick(["1-10", "11-50", "51-200", "201-1000", "1000+"]), plan_interest: pick(["pro", "enterprise"]) });
    }
    if (p === "/signup") {
      if (chance(0.85)) evt("custom_event", 0.15, "signup_started", { plan: ctx.plan || "free", method: pick(["email", "email", "google", "github"]) });
      const proceeds = path[i + 1] === "/welcome";
      if (proceeds || chance(0.5)) {
        evt("input_change", 0.3, "", { element: "input", inputType: "email", inputName: "email", formId: "signup-form", formName: "signup" });
        if (chance(0.7)) evt("input_change", 0.45, "", { element: "input", inputType: "password", inputName: "password", formId: "signup-form", formName: "signup" });
      }
      if (proceeds) {
        evt("form_submit", 0.85, "", { formId: "signup-form", formName: "signup", formAction: `https://${CFG.hostname}/api/signup`, method: "POST", fieldCount: 3 });
        evt("custom_event", 0.92, "signup_completed", { plan: ctx.plan || "free", method: pick(["email", "google", "github"]) });
        signedUp = true;
      }
    }
    if (p === "/login" && chance(0.7)) {
      evt("input_change", 0.4, "", { element: "input", inputType: "email", inputName: "email", formId: "login-form", formName: "login" });
      if (path[i + 1] === "/welcome") evt("form_submit", 0.8, "", { formId: "login-form", formName: "login", formAction: `https://${CFG.hostname}/api/login`, method: "POST", fieldCount: 2 });
    }
    if (p === "/welcome") {
      if (signedUp || (!identified && path[i - 1] === "/signup")) {
        // The visitor is now a known user: identify, and tag every later event.
        const first = pick(FIRST);
        const last = pick(LAST);
        const plan = ctx.plan || "free";
        v.userId = `usr_${String(10000 + v.n).padStart(5, "0")}`;
        v.traits = {
          name: `${first} ${last}`,
          email: `${first}.${last}${v.n}@${pick(["gmail.com", "outlook.com", "proton.me", "company.example"])}`.toLowerCase().replace(/[^a-z0-9.@_-]/g, ""),
          plan,
          company: chance(0.6) ? pick(COMPANIES) : undefined,
          country: v.country,
          signup_source: sourceId,
          signed_up_at: new Date(visit.startMs).toISOString(),
          seats: plan === "enterprise" ? randInt(20, 200) : plan === "pro" ? randInt(3, 15) : randInt(1, 3),
        };
        for (const k of Object.keys(v.traits)) if (v.traits[k] === undefined) delete v.traits[k];
        steps.push({ type: "identify", delay: 800, pathname: p, fields: { user_id: v.userId, traits: { ...v.traits }, is_new_identify: true }, meta: { pathname: p }, uid: v.userId });
        evt("custom_event", 0.5, "onboarding_viewed", { step: 1, plan });
        // From here on the visitor is identified.
      }
      if (chance(0.25)) evt("custom_event", 0.8, "invite_teammate_clicked", {});
    }

    // Outbound links on content-heavy pages
    if ((p.startsWith("/docs") || p.startsWith("/blog") || p === "/" || p === "/about" || p === "/changelog") && chance(0.12)) {
      const o = p.startsWith("/docs") ? pick([OUTBOUND.github, OUTBOUND.npm, OUTBOUND.docker, OUTBOUND.discord]) : p === "/" ? pick([OUTBOUND.github, OUTBOUND.g2, OUTBOUND.status]) : pick([OUTBOUND.twitter, OUTBOUND.linkedin, OUTBOUND.github]);
      evt("outbound", 0.95, "", { url: o.url, text: o.text, target: "_blank" });
    }
    ctx.lastDwell = Math.max(800, dwellMs - t); // what is left of the dwell time before the next page
  }

  // Customers on a later visit occasionally change plan.
  if (v.userId && returningVisitor && chance(0.08)) {
    steps.push({ type: "custom_event", delay: 3000, pathname: path[path.length - 1], fields: { pathname: path[path.length - 1], querystring: "", page_title: PAGES[path[path.length - 1]].title, event_name: "plan_upgraded", properties: JSON.stringify({ from: "free", to: "pro" }) }, meta: { pathname: path[path.length - 1] }, uid: v.userId });
    steps.push({ type: "identify", delay: 500, pathname: path[path.length - 1], fields: { user_id: v.userId, traits: { plan: "pro" }, is_new_identify: false }, meta: {}, uid: v.userId });
  }
  return { steps, entry, path };
}

// ---------------------------------------------------------------------------
// Request building (live path)
// ---------------------------------------------------------------------------

function browserHeaders(v, pathname) {
  const lang = v.language;
  const h = {
    "User-Agent": v.dev.userAgent,
    Accept: "*/*",
    "Accept-Language": `${lang},${lang.split("-")[0]};q=0.9,en;q=0.7`,
    "Accept-Encoding": "gzip, deflate, br",
    "Content-Type": "application/json",
    Origin: `https://${CFG.hostname}`,
    Referer: `https://${CFG.hostname}${pathname || "/"}`,
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "X-Forwarded-For": v.ip,
    "X-Real-IP": v.ip,
  };
  return h;
}

function trackRequest(v, step, headersFor = browserHeaders) {
  const payload = {
    site_id: CFG.siteId,
    type: step.type,
    hostname: CFG.hostname,
    pathname: step.fields.pathname ?? step.pathname ?? "/",
    querystring: step.fields.querystring ?? "",
    page_title: step.fields.page_title ?? "",
    referrer: step.fields.referrer ?? "",
    anonymous_id: v.anonId,
  };
  // Scripting clients send no screen, language or client bot score; real browsers always do.
  if (v.dev.screenWidth > 0) {
    payload.screenWidth = v.dev.screenWidth;
    payload.screenHeight = v.dev.screenHeight;
  }
  if (v.language) payload.language = v.language;
  if (!v.bot) {
    payload._bs = 0;
    payload._bsm = 0;
  }
  if (step.fields.event_name !== undefined) payload.event_name = step.fields.event_name;
  if (step.fields.properties !== undefined) payload.properties = step.fields.properties;
  for (const k of ["lcp", "cls", "inp", "fcp", "ttfb"]) if (step.fields[k] !== undefined) payload[k] = step.fields[k];
  if (step.uid) payload.user_id = step.uid;
  if (v.bot) Object.assign(payload, v.botSignals || {});
  const headers = headersFor(v, payload.pathname);
  if (CFG.trusted) {
    payload.ip_address = v.ip;
    payload.user_agent = v.dev.userAgent;
    headers.Authorization = `Bearer ${CFG.apiKey}`;
  }
  return { method: "POST", url: `${CFG.baseUrl}/api/track`, headers, body: payload, kind: step.type };
}

function identifyRequest(v, fields) {
  const body = { site_id: CFG.siteId, anonymous_id: v.anonId, user_id: fields.user_id, traits: fields.traits, is_new_identify: fields.is_new_identify };
  const headers = browserHeaders(v, "/welcome");
  if (CFG.trusted) {
    body.ip_address = v.ip;
    body.user_agent = v.dev.userAgent;
    headers.Authorization = `Bearer ${CFG.apiKey}`;
  }
  return { method: "POST", url: `${CFG.baseUrl}/api/identify`, headers, body, kind: "identify" };
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

const BOT_KINDS = [
  { w: 14, name: "Googlebot", ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", ips: BOT_IPS.googlebot, headers: "crawler", pages: [1, 3] },
  { w: 8, name: "bingbot", ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", ips: BOT_IPS.bingbot, headers: "crawler", pages: [1, 3] },
  { w: 8, name: "GPTBot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)", ips: BOT_IPS.azure, headers: "crawler", pages: [2, 6] },
  { w: 6, name: "ClaudeBot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", ips: BOT_IPS.aws, headers: "crawler", pages: [2, 6] },
  { w: 7, name: "AhrefsBot", ua: "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)", ips: BOT_IPS.ovh, headers: "crawler", pages: [2, 5] },
  { w: 5, name: "SemrushBot", ua: "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)", ips: BOT_IPS.gcp, headers: "crawler", pages: [2, 5] },
  { w: 5, name: "Bytespider", ua: "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)", ips: BOT_IPS.aws, headers: "crawler", pages: [1, 4] },
  { w: 8, name: "python-requests", ua: "python-requests/2.31.0", ips: BOT_IPS.hetzner, headers: "bare", pages: [1, 4] },
  { w: 6, name: "curl", ua: "curl/8.5.0", ips: BOT_IPS.digitalocean, headers: "bare", pages: [1, 2] },
  { w: 5, name: "Go-http-client", ua: "Go-http-client/2.0", ips: BOT_IPS.aws, headers: "bare", pages: [1, 3] },
  { w: 9, name: "HeadlessChrome", ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.0.0 Safari/537.36", ips: [...BOT_IPS.aws, ...BOT_IPS.hetzner, ...BOT_IPS.contabo], headers: "headless", pages: [1, 4], screen: [800, 600], signals: { _bs: 7, _bsm: 1 | 4 | 16 | 32 } },
  { w: 4, name: "Scraper burst", ua: "python-requests/2.31.0", ips: BOT_IPS.hetzner, headers: "bare", pages: [34, 40], burst: true },
];

function botHeaders(kind) {
  return (v, pathname) => {
    const h = { "User-Agent": v.dev.userAgent, "Content-Type": "application/json", "X-Forwarded-For": v.ip, "X-Real-IP": v.ip };
    if (kind.headers === "crawler") {
      h.Accept = "*/*";
      h["Accept-Encoding"] = "gzip, deflate";
    } else if (kind.headers === "headless") {
      h.Accept = "*/*";
      h["Accept-Encoding"] = "gzip, deflate, br";
      h.Origin = `https://${CFG.hostname}`;
      h.Referer = `https://${CFG.hostname}${pathname}`;
      h["Sec-Fetch-Site"] = "cross-site";
      h["Sec-Fetch-Mode"] = "cors";
    }
    return h;
  };
}

function makeBot() {
  const kind = pickW(BOT_KINDS, k => k.w);
  const [sw, sh] = kind.screen || [0, 0];
  const v = {
    n: ++visitorSeq,
    anonId: `bot-${hex(16)}`,
    country: "—",
    place: { city: "datacenter" },
    ip: pick(kind.ips),
    dev: { cls: "bot", prof: { browser: kind.name, os: "" }, userAgent: kind.ua, screenWidth: sw, screenHeight: sh },
    language: kind.headers === "headless" ? "en-US" : "",
    speed: 1,
    userId: null,
    bot: true,
    botKind: kind,
    botSignals: kind.signals || {},
    visits: [],
  };
  return v;
}

function simulateBotVisit(v) {
  const kind = v.botKind;
  const n = randInt(kind.pages[0], kind.pages[1]);
  const all = [...Object.keys(PAGES), ...Array.from({ length: 30 }, (_, i) => `/blog/archive/post-${i + 1}`)];
  const steps = [];
  for (let i = 0; i < n; i++) {
    const p = kind.burst ? all[(i * 7) % all.length] : pick(all);
    steps.push({ type: "pageview", delay: kind.burst ? 60 : randInt(800, 5000), pathname: p, fields: { pathname: p, querystring: "", page_title: PAGES[p]?.title || "", referrer: "" }, meta: { pathname: p } });
  }
  return { steps };
}

// ---------------------------------------------------------------------------
// Historical import rows (Umami format, see server/src/services/import/mappers/umami.ts)
// ---------------------------------------------------------------------------

function fmtUmamiTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}
function umamiRows(v, visit, sim, sessionId) {
  const rows = [];
  let t = visit.startMs;
  const device = v.dev.cls === "desktop" ? "Desktop" : "Mobile"; // the Umami mapper folds tablets into Mobile
  const distinctId = fingerprint(v.anonId);
  for (const step of sim.steps) {
    t += step.delay;
    if (step.type !== "pageview" && step.type !== "custom_event") continue;
    let refDomain = "";
    let refPath = "";
    if (step.type === "pageview" && step.meta.first && sim.entry.referrer) {
      const u = new URL(sim.entry.referrer);
      refDomain = u.hostname;
      refPath = u.pathname === "/" ? "" : u.pathname;
    }
    rows.push({
      session_id: sessionId,
      hostname: CFG.hostname,
      browser: v.dev.prof.browser,
      os: v.dev.prof.os,
      device,
      screen: `${v.dev.screenWidth}x${v.dev.screenHeight}`,
      language: v.language,
      country: v.country,
      region: v.place.region ? `${v.country}-${v.place.region}` : "",
      city: v.place.city,
      url_path: step.fields.pathname,
      url_query: (step.fields.querystring || "").replace(/^\?/, ""),
      referrer_path: step.type === "pageview" && step.meta.first ? refPath : "",
      referrer_domain: step.type === "pageview" && step.meta.first ? refDomain : "",
      page_title: step.fields.page_title || "",
      event_type: step.type === "pageview" ? "1" : "2",
      event_name: step.type === "pageview" ? "" : step.fields.event_name,
      distinct_id: distinctId,
      created_at: fmtUmamiTime(t),
    });
  }
  return rows;
}

/** user_id the server computes for an anonymous_id on an unsalted site (generateUserIdFromClientId). */
function fingerprint(anonId) {
  return createHash("sha256").update(`${numericSiteId ?? CFG.siteId}:${anonId}:`).digest("hex").substring(0, 12);
}

// ---------------------------------------------------------------------------
// Visit scheduling
// ---------------------------------------------------------------------------

function visitStartMs(v, daysAgo) {
  if (daysAgo === 0) return NOW;
  const tz = v.place.tz || "UTC";
  const hour = pickW(HOUR_W.map((w, h) => [w, h]))[1];
  const minute = randInt(0, 59);
  const dayStart = TODAY_START - daysAgo * DAY;
  // local wall-clock hour:minute on the UTC date `dayStart` -> instant
  let t = dayStart + (hour * 60 + minute) * MIN - tzOffsetMin(tz, dayStart + 12 * 3_600_000) * MIN;
  const latest = NOW - 90 * MIN;
  while (t > latest) t -= DAY;
  return t;
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

const stats = {
  requests: 0,
  ok: 0,
  skipped: 0, // 200 with a "not tracked" body (excluded / limit / no plan)
  failed: 0,
  byStatus: new Map(),
  byType: new Map(),
  failures: [],
  importRows: 0,
  importBatches: 0,
  identify: 0,
};

async function http(method, url, headers, body, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

function reportFailure(req, res, err) {
  stats.failed++;
  const entry = { url: req.url, status: res?.status ?? "network", body: res?.text ?? String(err), payload: req.body };
  if (stats.failures.length < 5) {
    stats.failures.push(entry);
    console.error(`\n!! ${req.method} ${req.url} -> ${entry.status}\n   response: ${String(entry.body).slice(0, 600)}\n   payload:  ${JSON.stringify(req.body).slice(0, 600)}`);
  }
  if (stats.failed >= 25) {
    console.error(`\nAborting: ${stats.failed} failed requests. First failures are printed above.`);
    printSummary();
    process.exit(1);
  }
}

async function send(req) {
  stats.requests++;
  bump(stats.byType, req.kind);
  let res;
  try {
    res = await http(req.method, req.url, req.headers, req.body);
  } catch (err) {
    reportFailure(req, null, err);
    return;
  }
  bump(stats.byStatus, res.status);
  if (!res.ok) {
    reportFailure(req, res);
    if (res.status === 404 && /Site not found/i.test(res.text)) {
      console.error("Site not found: check --site-id (the numeric id or the site identifier).");
      process.exit(1);
    }
    return;
  }
  if (/not tracked|not stored/i.test(res.text)) {
    stats.skipped++;
    if (stats.skipped <= 3) console.warn(`   note: server accepted but did not track (${res.text.slice(0, 120)})`);
  } else stats.ok++;
}

async function runPool(tasks, n) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, tasks.length || 1) }, async () => {
      while (i < tasks.length) {
        const t = tasks[i++];
        await t();
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const sim = { countries: new Map(), devices: new Map(), browsers: new Map(), os: new Map(), langs: new Map(), sources: new Map(), eventTypes: new Map(), liveVisits: 0, backfillVisits: 0, botVisits: 0, identified: new Set(), pages: new Map() };
function top(map, n = 12) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${k}=${c}`).join("  ");
}
function printSummary() {
  console.log("\n==== Summary ====");
  console.log(`visits: ${sim.liveVisits} live, ${sim.backfillVisits} backfilled, ${sim.botVisits} bot`);
  console.log(`visitors by country: ${top(sim.countries, 30)}`);
  console.log(`devices:  ${top(sim.devices)}`);
  console.log(`browsers: ${top(sim.browsers)}`);
  console.log(`os:       ${top(sim.os)}`);
  console.log(`languages:${top(sim.langs, 8)}`);
  console.log(`sources:  ${top(sim.sources, 20)}`);
  console.log(`events by type (planned, all paths): ${top(sim.eventTypes, 20)}`);
  console.log(`identified users planned: ${sim.identified.size}`);
  console.log(`HTTP: ${stats.requests} requests (track ${[...stats.byType.entries()].filter(([k]) => k !== "identify").reduce((s, [, c]) => s + c, 0)}, identify ${stats.byType.get("identify") || 0}); accepted ${stats.ok}, accepted-but-skipped ${stats.skipped}, failed ${stats.failed}`);
  console.log(`status codes: ${top(stats.byStatus)}`);
  if (stats.importRows) console.log(`history import: ${stats.importRows} rows in ${stats.importBatches} batch(es)`);
  console.log(`live events sent by type: ${top(stats.byType, 20)}`);
}

// ---------------------------------------------------------------------------
// check-geo / validation helpers
// ---------------------------------------------------------------------------

const serverRequire = createRequire(path.join(SERVER_DIR, "package.json"));
function tryRequire(name) {
  try {
    return serverRequire(name);
  } catch {
    return null;
  }
}

async function checkGeo() {
  const maxmind = tryRequire("@maxmind/geoip2-node");
  if (!maxmind) {
    console.error("Cannot load @maxmind/geoip2-node from server/node_modules - run `pnpm install` first.");
    process.exit(1);
  }
  const cityDb = maxmind.Reader.openBuffer(readFileSync(path.join(SERVER_DIR, "GeoLite2-City.mmdb")));
  const asnPath = path.join(SERVER_DIR, "GeoLite2-ASN.mmdb");
  const asnDb = existsSync(asnPath) ? maxmind.Reader.openBuffer(readFileSync(asnPath)) : null;
  const look = ip => {
    let c = null;
    let a = null;
    try { c = cityDb.city(ip); } catch {}
    try { a = asnDb?.asn(ip); } catch {}
    return { country: c?.country?.isoCode, city: c?.city?.names?.en, region: c?.subdivisions?.[0]?.isoCode ?? "", tz: c?.location?.timeZone, asn: a?.autonomousSystemNumber, org: a?.autonomousSystemOrganization };
  };
  let bad = 0;
  let total = 0;
  console.log("country  city                      region ip               geo-result                      ASN / org");
  for (const [cc, city, region, , ips] of GEO_ROWS) {
    for (const ip of ips) {
      const tries = [ip];
      for (const t of tries) {
        total++;
        const r = look(t);
        const ok = r.country === cc && r.city === city && (r.region || "") === region;
        if (!ok) bad++;
        console.log(`${ok ? "ok " : "BAD"} ${cc.padEnd(4)} ${city.padEnd(24)} ${region.padEnd(6)} ${t.padEnd(16)} ${`${r.country ?? "?"}/${r.city ?? "?"}/${r.region ?? ""}`.padEnd(30)} AS${r.asn ?? "?"} ${r.org ?? ""}`);
      }
    }
  }
  console.log("\nBot / datacenter IPs");
  for (const [group, ips] of Object.entries(BOT_IPS)) {
    for (const ip of ips) {
      const r = look(ip);
      console.log(`    ${group.padEnd(13)} ${ip.padEnd(16)} ${r.country ?? "?"}/${r.city ?? "-"}  AS${r.asn ?? "?"} ${r.org ?? ""}`);
      if (!r.asn) bad++;
    }
  }
  console.log(`\nGeo check: ${total - bad}/${total + 0} residential lookups matched`);

  // user agents -> the names the importer will store
  const UAParser = tryRequire("ua-parser-js");
  let uaBad = 0;
  if (UAParser) {
    const Parser = UAParser.UAParser || UAParser;
    console.log("\nUser agents (profile name -> ua-parser-js)");
    for (const [family, list] of Object.entries(UAS)) {
      for (const prof of list) {
        const ua = prof.ua(prof.v[0]);
        const r = new Parser(ua).getResult();
        const ok = r.browser.name === prof.browser && (r.os.name === prof.os);
        if (!ok) uaBad++;
        console.log(`${ok ? "ok " : "BAD"} ${family.padEnd(14)} expected ${prof.browser}/${prof.os}  parsed ${r.browser.name}/${r.os.name} device=${r.device.type ?? "-"}`);
      }
    }
  } else console.log("\nua-parser-js not found in server/node_modules; skipped user-agent check");
  const missingCountries = Object.keys(COUNTRIES).filter(cc => !CITIES.has(cc));
  console.log(`Countries simulated: ${Object.keys(COUNTRIES).length}${missingCountries.length ? " (missing geo rows: " + missingCountries.join(",") + ")" : ""}`);
  process.exit(bad || uaBad ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Preflight + setup (REST calls that need an API key)
// ---------------------------------------------------------------------------

function authHeaders() {
  return { Authorization: `Bearer ${CFG.apiKey}`, "Content-Type": "application/json" };
}

async function must(method, url, headers, body, what) {
  const res = await http(method, url, headers, body);
  if (!res.ok) {
    console.error(`\n!! ${what}: ${method} ${url} -> HTTP ${res.status}\n   ${res.text.slice(0, 800)}`);
    process.exit(1);
  }
  return res.text ? safeJson(res.text) : null;
}
const safeJson = t => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

async function preflight() {
  const health = await http("GET", `${CFG.baseUrl}/api/health`, {}).catch(err => ({ ok: false, status: 0, text: String(err) }));
  if (!health.ok) {
    console.error(`!! Backend not reachable at ${CFG.baseUrl} (GET /api/health -> ${health.status}: ${health.text.slice(0, 300)})`);
    process.exit(1);
  }
  const cfgRes = await http("GET", `${CFG.baseUrl}/api/site/tracking-config/${encodeURIComponent(CFG.siteId)}`, {});
  if (!cfgRes.ok) {
    console.error(`!! Site ${CFG.siteId} lookup failed: HTTP ${cfgRes.status} ${cfgRes.text.slice(0, 400)}`);
    process.exit(1);
  }
  const cfg = safeJson(cfgRes.text);
  const off = ["webVitals", "trackErrors", "trackOutbound", "trackButtonClicks", "trackCopy", "trackFormInteractions"].filter(k => cfg && cfg[k] === false);
  console.log(`Site ${CFG.siteId} found (tracking config: ${JSON.stringify(cfg)})`);
  if (off.length) console.warn(`   warning: ${off.join(", ")} disabled in site settings. The server still stores these events, but the tracker script and some dashboards will treat them as off. Use --setup (needs --api-key) or enable them in Site Settings.`);
}

async function runSetup() {
  if (!CFG.apiKey || !numericSiteId) throw new Error("--setup needs --api-key and a numeric --site-id");
  const H = authHeaders();
  console.log("Setup: enabling tracking features...");
  await must("PUT", `${CFG.baseUrl}/api/sites/${numericSiteId}/config`, H, {
    domain: CFG.hostname,
    saltUserIds: false, // keeps returning visitors recognisable across days
    blockBots: true, // bot hits go to the bot detection page instead of the events table
    webVitals: true,
    trackErrors: true,
    trackOutbound: true,
    trackUrlParams: true,
    trackButtonClicks: true,
    trackCopy: true,
    trackFormInteractions: true,
  }, "update site config");

  const existing = JSON.stringify([await getJson(`${CFG.baseUrl}/api/sites/${numericSiteId}/goals?pageSize=100`, H), await getJson(`${CFG.baseUrl}/api/sites/${numericSiteId}/funnels`, H)]);
  const goals = [
    { name: "Signup completed", goalType: "path", config: { pathPattern: "/welcome" } },
    { name: "Signup started", goalType: "event", config: { eventName: "signup_started" } },
    { name: "Plan selected", goalType: "event", config: { eventName: "plan_selected" } },
    { name: "Demo requested", goalType: "event", config: { eventName: "demo_requested" } },
    { name: "Newsletter subscribed", goalType: "event", config: { eventName: "newsletter_subscribed" } },
    { name: "Pro plan chosen", goalType: "event", config: { eventName: "plan_selected", propertyFilters: [{ key: "plan", value: "pro" }] } },
  ];
  for (const g of goals) {
    if (existing.includes(`"${g.name}"`)) { console.log(`   goal exists: ${g.name}`); continue; }
    await softPost(`${CFG.baseUrl}/api/sites/${numericSiteId}/goals`, H, g, `goal "${g.name}"`);
  }
  const funnels = [
    { name: "Signup flow", steps: [{ type: "page", value: "/", name: "Home" }, { type: "page", value: "/pricing", name: "Pricing" }, { type: "page", value: "/signup", name: "Signup" }, { type: "page", value: "/welcome", name: "Welcome" }] },
    { name: "Signup events", steps: [{ type: "event", value: "plan_selected", name: "Plan selected" }, { type: "event", value: "signup_started", name: "Signup started" }, { type: "event", value: "signup_completed", name: "Signup completed" }] },
    { name: "Docs to signup", steps: [{ type: "page", value: "/docs/quickstart", name: "Quickstart" }, { type: "page", value: "/signup", name: "Signup" }] },
  ];
  for (const f of funnels) {
    if (existing.includes(`"${f.name}"`)) { console.log(`   funnel exists: ${f.name}`); continue; }
    await softPost(`${CFG.baseUrl}/api/sites/${numericSiteId}/funnels`, H, f, `funnel "${f.name}"`);
  }
}
async function getJson(url, headers) {
  const r = await http("GET", url, headers).catch(() => null);
  return r?.ok ? safeJson(r.text) : null;
}
async function softPost(url, headers, body, what) {
  const r = await http("POST", url, headers, body).catch(e => ({ ok: false, status: 0, text: String(e) }));
  if (r.ok) console.log(`   created ${what}`);
  else console.warn(`   !! could not create ${what}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// Backfill via the Umami import endpoints
// ---------------------------------------------------------------------------

async function runBackfill(rows) {
  const H = authHeaders();
  console.log(`Backfill: creating import and uploading ${rows.length} historical rows...`);
  const created = await must("POST", `${CFG.baseUrl}/api/sites/${numericSiteId}/imports`, H, { platform: "umami" }, "create import");
  const importId = created?.data?.importId;
  if (!importId) throw new Error(`Unexpected create-import response: ${JSON.stringify(created)}`);
  const BATCH = 2000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const last = i + BATCH >= rows.length;
    const res = await http("POST", `${CFG.baseUrl}/api/sites/${numericSiteId}/imports/${importId}/events`, H, { events: rows.slice(i, i + BATCH), isLastBatch: last }, { timeoutMs: 120_000 });
    if (!res.ok) {
      console.error(`!! import batch ${i / BATCH + 1} failed: HTTP ${res.status} ${res.text.slice(0, 800)}`);
      process.exit(1);
    }
    stats.importRows += Math.min(BATCH, rows.length - i);
    stats.importBatches++;
  }
  console.log(`   import ${importId} complete`);
}

// ---------------------------------------------------------------------------
// Dry run validation
// ---------------------------------------------------------------------------

async function loadServerSchemas() {
  const out = {};
  // The server modules open GeoLite2-*.mmdb relative to the working directory.
  try { process.chdir(SERVER_DIR); } catch {}
  try {
    const mod = await import(pathToFileURL(path.join(SERVER_DIR, "dist/services/tracker/trackingPayload.js")).href);
    out.trackSchema = mod.trackingPayloadSchema;
  } catch (e) {
    console.warn(`   (could not load server/dist trackingPayload schema: ${String(e.message).split("\n")[0]}. Build the server or run pnpm build:server for schema validation.)`);
  }
  try {
    const mod = await import(pathToFileURL(path.join(SERVER_DIR, "dist/services/import/mappers/umami.js")).href);
    out.umami = mod.UmamiImportMapper;
  } catch (e) {
    console.warn(`   (could not load Umami mapper: ${String(e.message).split("\n")[0]})`);
  }
  const zod = tryRequire("zod");
  if (zod) {
    const z = zod.z || zod;
    out.identifySchema = z.object({
      site_id: z.string().min(1),
      anonymous_id: z.string().min(1).max(255).optional(),
      user_id: z.string().min(1).max(255),
      ip_address: z.string().ip().optional(),
      user_agent: z.string().max(512).optional(),
      traits: z.record(z.unknown()).optional().refine(t => !t || new TextEncoder().encode(JSON.stringify(t)).length <= 2048),
      is_new_identify: z.boolean().default(true),
    }); // mirrors identifyPayloadSchema in server/src/services/tracker/identifyService.ts
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function registerVisit(v, steps, kind) {
  bump(sim.countries, v.country);
  if (kind === "bot") return;
  bump(sim.devices, v.dev.cls);
  bump(sim.browsers, v.dev.prof.browser);
  bump(sim.os, v.dev.prof.os);
  bump(sim.langs, v.language);
}

async function main() {
  if (CFG.checkGeo) return checkGeo();
  if (!CFG.siteId && !CFG.dryRun) {
    console.error("--site-id is required (or env RYBBIT_SITE_ID).\n");
    console.error(HELP);
    process.exit(2);
  }
  if (!CFG.siteId) CFG.siteId = "1";

  console.log(`Rybbit demo traffic: ${CFG.visitors} visitors, ${CFG.bots} bots, ${CFG.days} days, seed ${CFG.seed}`);
  console.log(`  target ${CFG.baseUrl}, site ${CFG.siteId}, host ${CFG.hostname}, ${BACKFILL_ENABLED ? `backfill ON (${CFG.rich} visitors live today)` : "backfill OFF (all traffic stamped now)"}${CFG.trusted ? ", trusted ingestion" : ""}`);
  if (!BACKFILL_ENABLED) {
    console.warn(CFG.apiKey && !numericSiteId ? "   warning: backfill needs a numeric --site-id; sending everything live." : "   note: no --api-key (or --no-backfill), so the server will stamp every event with the current time. Pass --api-key for 30 days of history.");
  }

  if (!CFG.dryRun) {
    await preflight();
    if (CFG.setup) await runSetup();
  }

  // ---- plan ----
  const visitors = planVisitors();
  const liveJobs = []; // {v, steps}
  const backfillRows = [];
  const backfillIdentifies = []; // identify calls to run after the import
  let identifySeq = 0;
  for (const v of visitors) {
    for (let idx = 0; idx < v.visits.length; idx++) {
      const visit = v.visits[idx];
      const live = visit.daysAgo === 0 || !BACKFILL_ENABLED;
      visit.startMs = visitStartMs(v, visit.daysAgo);
      const ctx = { visitIndex: idx, lastDwell: 0, plan: null };
      const s = simulateVisit(v, visit, ctx);
      for (const st of s.steps) bump(sim.eventTypes, st.type);
      bump(sim.sources, s.entry.sourceId);
      if (idx === 0) registerVisit(v, s.steps, "human");
      if (v.userId) sim.identified.add(v.userId);
      if (live) {
        sim.liveVisits++;
        liveJobs.push({ v, steps: s.steps, startMs: visit.startMs });
      } else {
        sim.backfillVisits++;
        backfillRows.push(...umamiRows(v, visit, s, uuid()));
        for (const st of s.steps) if (st.type === "identify") backfillIdentifies.push({ v, fields: st.fields });
      }
    }
  }
  // Bots
  const botJobs = [];
  for (let i = 0; i < CFG.bots; i++) {
    const v = makeBot();
    const s = simulateBotVisit(v);
    sim.botVisits++;
    bump(sim.eventTypes, "bot-pageview", s.steps.length);
    bump(sim.sources, `bot:${v.botKind.name}`);
    botJobs.push({ v, steps: s.steps });
  }

  // ---- dry run ----
  if (CFG.dryRun) {
    const schemas = await loadServerSchemas();
    const allReqs = [];
    for (const job of [...liveJobs, ...botJobs]) {
      const headersFor = job.v.bot ? botHeaders(job.v.botKind) : browserHeaders;
      for (const st of job.steps) allReqs.push(st.type === "identify" ? identifyRequest(job.v, st.fields) : trackRequest(job.v, st, headersFor));
    }
    for (const x of backfillIdentifies) allReqs.push(identifyRequest(x.v, x.fields));
    console.log(`\nFirst ${CFG.dryRun} of ${allReqs.length} live requests:`);
    const samples = [];
    const seenKinds = new Set();
    for (const r of allReqs) if (!seenKinds.has(r.kind) && samples.length < CFG.dryRun) { seenKinds.add(r.kind); samples.push(r); }
    for (const r of allReqs) if (samples.length < CFG.dryRun && !samples.includes(r)) samples.push(r);
    for (const r of samples) console.log(JSON.stringify({ method: r.method, url: r.url, headers: { ...r.headers, Authorization: r.headers.Authorization ? "Bearer ***" : undefined }, body: r.body }, null, 2));

    let invalid = 0;
    let checked = 0;
    for (const r of allReqs) {
      const schema = r.kind === "identify" ? schemas.identifySchema : schemas.trackSchema;
      if (!schema) continue;
      checked++;
      const res = schema.safeParse(r.body);
      if (!res.success) {
        invalid++;
        if (invalid <= 5) console.error(`INVALID ${r.kind}: ${JSON.stringify(res.error.flatten())}\n   ${JSON.stringify(r.body).slice(0, 400)}`);
      }
    }
    console.log(`\nSchema validation: ${checked - invalid}/${checked} requests valid ${schemas.trackSchema ? "(server/dist trackingPayloadSchema)" : "(track schema NOT loaded)"}`);
    let dropped = 0;
    if (schemas.umami && backfillRows.length) {
      const transformed = schemas.umami.transform(backfillRows, numericSiteId ?? 1, "00000000-0000-4000-8000-000000000000");
      dropped = backfillRows.length - transformed.length;
      const keyOnly = backfillRows.filter(r => !schemas.umami.umamiEventKeyOnlySchema.safeParse(r).success).length;
      console.log(`Umami import validation: ${transformed.length}/${backfillRows.length} rows survive the mapper (${dropped} dropped, ${keyOnly} fail the batch schema)`);
      if (transformed.length) {
        const countries = new Set(transformed.map(r => r.country));
        console.log(`   sample imported row: ${JSON.stringify(transformed[0])}`);
        console.log(`   countries in history: ${countries.size}; first/last timestamp: ${transformed.map(r => r.timestamp).sort()[0]} / ${transformed.map(r => r.timestamp).sort().slice(-1)[0]}`);
      }
    } else if (backfillRows.length) console.log(`Umami mapper not loaded; ${backfillRows.length} backfill rows generated unverified`);
    stats.importRows = backfillRows.length;
    printSummary();
    process.exit(invalid || dropped ? 1 : 0);
  }

  // ---- send ----
  if (backfillRows.length) {
    await runBackfill(backfillRows);
    // identify calls after the import: the server backfills identified_user_id onto the imported history
    const idTasks = backfillIdentifies.map(x => () => send(identifyRequest(x.v, x.fields)));
    await runPool(idTasks, CFG.concurrency);
  }

  const runJob = async (job, scale) => {
    const headersFor = job.v.bot ? botHeaders(job.v.botKind) : browserHeaders;
    for (const st of job.steps) {
      const delay = job.v.bot && job.v.botKind.burst ? st.delay : Math.max(120, st.delay * scale);
      await sleep(Math.min(delay, 20_000));
      await send(st.type === "identify" ? identifyRequest(job.v, st.fields) : trackRequest(job.v, st, headersFor));
    }
  };
  const total = liveJobs.length + botJobs.length;
  console.log(`Sending ${liveJobs.length} live visits and ${botJobs.length} bot visits through /api/track...`);
  // Shuffle so bots and humans interleave
  const all = [...liveJobs.map(j => () => runJob(j, CFG.timeScale)), ...botJobs.map(j => () => runJob(j, CFG.timeScale))];
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  let done = 0;
  const ticker = setInterval(() => console.log(`   ... ${stats.requests} requests sent (${done}/${total} visits)`), 5000);
  await runPool(all.map(t => async () => { await t(); done++; }), CFG.concurrency);
  clearInterval(ticker);

  // ---- live trickle ----
  if (CFG.liveMinutes > 0) {
    console.log(`Live mode: ~${CFG.liveRate} visitors/min for ${CFG.liveMinutes} min (Ctrl-C to stop)...`);
    const endAt = Date.now() + CFG.liveMinutes * MIN;
    const pool = visitors.filter(v => v.visits.length);
    let spawned = 0;
    const running = new Set();
    while (Date.now() < endAt) {
      await sleep(clamp(-Math.log(1 - rng()) * (MIN / CFG.liveRate), 200, 30_000));
      let v;
      let idx = 1;
      if (pool.length && chance(0.3)) { v = pick(pool); idx = v.visits.length; }
      else { v = makeVisitor(); idx = 0; pool.push(v); v.visits.push({ daysAgo: 0 }); }
      const visit = { daysAgo: 0, startMs: Date.now() };
      const s = simulateVisit(v, visit, { visitIndex: idx, lastDwell: 0, plan: null });
      spawned++;
      sim.liveVisits++;
      for (const st of s.steps) bump(sim.eventTypes, st.type);
      bump(sim.sources, s.entry.sourceId);
      registerVisit(v, s.steps, "human");
      const p = runJob({ v, steps: s.steps }, CFG.liveTimeScale).finally(() => running.delete(p));
      running.add(p);
      if (spawned % 10 === 0) console.log(`   live: ${spawned} visitors started, ${stats.requests} requests, ${stats.failed} failed`);
    }
    await Promise.all(running);
  }

  printSummary();
  if (stats.failed) {
    console.error(`\n${stats.failed} request(s) failed - see messages above.`);
    process.exit(1);
  }
  console.log("\nDone. Events appear in the dashboard after the server's batch flush (a few seconds).");
}

main().catch(err => {
  console.error(err?.stack || err);
  process.exit(1);
});
