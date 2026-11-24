# Demo traffic generator

`generate-traffic.mjs` simulates the visitors of a fictional international SaaS site (Lumenly) against a running
Rybbit backend, so every dashboard section has data: overview, pages, channels and referrers, UTM campaigns,
countries/regions/cities (map and globe), devices/browsers/OS/screen sizes, languages, sessions, users (with traits),
custom events with properties, goals, funnels, journeys, retention, outbound links, errors, web vitals, button
clicks / copy / form interactions and bot traffic.

No npm dependencies (Node 22 built-in `fetch`). `--check-geo` and `--dry-run` borrow the server's own
`node_modules` and `server/dist`, so run `pnpm install` and `pnpm build:server` first if you want those checks.

## Before you run it

1. Start the stack (backend on port 3001 by default, `docker compose up` or `pnpm dev:server`).
2. Create a site in the dashboard and note its **numeric site id** (Site Settings, or the URL).
3. Create an **API key** (Settings, API keys) if you want history, `--setup`, or `--trusted`:
   - historical backfill and `--setup` need `sites:write` (this covers imports and site config) plus `goals:write` and
     `funnels:write` for the demo goals and funnels, or an unrestricted legacy key;
   - `--trusted` additionally needs `ingest:write`.
4. In Site Settings turn on Web Vitals, Error tracking, Outbound, Button clicks, Copy and Form interactions, and keep
   "Block bots" on. The server stores these events whatever the settings, but the dashboards (and the real tracker
   script) treat disabled features as off. `--setup` does this for you through `PUT /api/sites/:id/config`.
5. Leave "Salt user IDs" off (the default). With a daily salt a visitor gets a new identity every day, which breaks
   retention and the link between imported history and live traffic. `--setup` sets this too.

## Usage

```bash
# everything: 30 days of history + today's rich traffic + site setup + 5 minutes of live trickle
node scripts/demo/generate-traffic.mjs --site-id 1 --api-key rb_xxx --setup --live 5

# no API key: all traffic goes through /api/track and is stamped "now"
node scripts/demo/generate-traffic.mjs --site-id 1 --visitors 300

# validate without a backend
node scripts/demo/generate-traffic.mjs --check-geo
node scripts/demo/generate-traffic.mjs --dry-run 10 --site-id 1 --api-key x
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--base-url` | `http://localhost:3001` | Backend. 3001 is the port the server listens on (`server/src/index.ts`); behind Caddy use your public URL, but see "IP and geolocation" below. Env `RYBBIT_BASE_URL`. |
| `--site-id` | required | Numeric site id (a site identifier string works for live traffic only). Env `RYBBIT_SITE_ID`. |
| `--api-key` | none | Enables backfill, `--setup`, `--trusted`. Env `RYBBIT_API_KEY`. |
| `--visitors` | 600 | Unique human visitors. About 25% come back on later days. |
| `--days` | 30 | History window. |
| `--rich` | max(60, 15% of visitors) | Visitors whose latest visit happens "today" through `/api/track` with every event type. |
| `--bots` | 4% of visitors | Bot visitors (crawlers, scripting clients, headless Chrome, a scraper burst). |
| `--live [min]` | off (5 if no value) | Keep sending visitors for N minutes after the batch so Realtime shows activity. `--live-rate` sets visitors per minute (8). |
| `--seed` | 42 | PRNG seed; the same seed produces the same simulation. |
| `--hostname` | `demo.lumenly.example` | Hostname reported in events. |
| `--concurrency` | 6 | Parallel visitors. |
| `--time-scale` | 0.02 | Multiplier on dwell time between a visitor's events (1 = real time). `--live-time-scale` (0.2) applies to the live phase. |
| `--trusted` | off | Send `ip_address`/`user_agent` in the payload with the API key (needs `ingest:write`). Use it when a reverse proxy overwrites `X-Forwarded-For`. Bot detection then only runs its user-agent layer. |
| `--setup` | off | Enable tracking features, disable salting, create demo goals and funnels. |
| `--no-backfill` | off | Skip the history import. |
| `--check-geo` | | Print country, city, region and ASN for every simulated IP from `server/GeoLite2-*.mmdb`, and check user-agent parsing. Exits non-zero on a mismatch. |
| `--dry-run [n]` | | Send nothing, print n sample requests, validate every payload with the server's zod schema (`server/dist`) and the Umami import mapper. |

## How it works

**Live path** (`POST /api/track`, `POST /api/identify`, public, no auth). One event per request, validated by the strict
schema in `server/src/services/tracker/trackingPayload.ts`. Event types sent: `pageview`, `custom_event`, `performance`
(web vitals), `error`, `outbound`, `button_click`, `copy`, `form_submit`, `input_change`. The payload mirrors what the
real tracker script sends, with headers a browser would send (`User-Agent`, `Accept-Language`, `Origin`, `Referer`,
`Sec-Fetch-*`, `Accept-Encoding: gzip`) so bot detection does not drop it. Each simulated visitor sends a stable
`anonymous_id`, so identities are exact even when many visitors share an IP. Visitors who finish `/signup` are identified
(`/api/identify`) with traits, and their later events carry `user_id`.

**IP and geolocation.** The server resolves the client IP from `X-Real-IP`, then the first `X-Forwarded-For` entry
(`resolveClientIp.ts`; no Cloudflare header is sent) and looks it up in `server/GeoLite2-City.mmdb`. The script picks
real ISP addresses for 26 countries (4 to 6 cities each; run `--check-geo` to see them). If a proxy in front of the
backend overwrites `X-Forwarded-For` (Caddy can), every visitor shows up as the proxy's address:
point `--base-url` at the backend port directly or use `--trusted`.

**Timestamps.** The server stamps events with its own receive time; the payload cannot carry one. History therefore uses
the only official historical path: the site import API with the Umami format
(`POST /api/sites/:id/imports`, then `POST /api/sites/:id/imports/:importId/events`), which needs the API key. Imported
rows contain pageviews and custom events (names only, no properties) with country, region, city, browser, OS, device,
screen, language, referrer and UTM query. They do not contain errors, web vitals, clicks, copy, form events or outbound
links, and tablets are folded into "Mobile" by the importer. Imported `user_id` values are computed exactly as the server
computes them for an `anonymous_id`, so a visitor imported on day 10 and seen again today is one returning user, and
visitors who signed up in the history are identified after the import (the server then back-fills
`identified_user_id` for the last 30 days). Rich events (errors, vitals, interactions, event properties) are therefore
only present for "today" and the `--live` phase. Self-hosted instances have no import quota; on Cloud the free plan cannot
import.

**Bots.** About 4% extra visitors: Googlebot, bingbot, GPTBot, ClaudeBot, AhrefsBot, SemrushBot, Bytespider,
python-requests, curl, Go-http-client, a HeadlessChrome profile with automation signals from datacenter IPs (AWS, Hetzner,
DigitalOcean, OVH, Contabo, GCP, Azure) and a scraper that fires ~35 distinct paths in a few seconds. With "Block bots"
on they land in the bot detection page; they never touch the normal analytics.

**Not covered:** session replay (rrweb data is not simulated) and feature flags / experiments.

## Demo page

`site.html` loads the real tracking script (`<backend>/api/script.js`, site id from the `?site=` parameter or the form)
and has buttons for custom events, identify, errors, outbound links, copy and form interaction:

```bash
python3 -m http.server 5500 --directory scripts/demo
# open http://localhost:5500/site.html?site=1&base=http://localhost:3001
```

## Notes

- Normal visitors are not bot-filtered: current browser versions (141+), full header set, plausible screens (no square,
  800x600, 1024x768 or 1280x1200 desktops), realistic pacing per IP and user agent, and one `X-Forwarded-For` per visitor.
- The batch phase compresses dwell time (`--time-scale 0.02`), so live sessions last seconds, not minutes. Use
  `--time-scale 1` for real durations (slow). Historical sessions use realistic durations.
- A run adds data; it does not clear anything. Use a fresh site (or delete the import in Site Settings, Imports) to start over.
- The script exits non-zero on any failed request and prints the response body of the first failures.

## Full before/after demo

`run-demo.sh` proves the fork's unlocked features by screenshotting the **stock upstream build** and this **fork** against
the **same generated data**, then writes a side-by-side `screenshots/REPORT.md`.

```bash
scripts/demo/run-demo.sh             # Postgres schema must already exist
scripts/demo/run-demo.sh --migrate   # opt-in: runs drizzle-kit migrate on the disposable demo database first
```

### One-time setup

```bash
# 1. Databases from the regular compose file
docker compose up -d clickhouse postgres redis
# 2. A small proxy on :8080 that routes /api to the backend (3001) and the rest to the client (3002), like production Caddy
docker run -d --name devproxy --network host -v "$PWD/scripts/demo/Caddyfile:/etc/caddy/Caddyfile" caddy:2.10.0
# 3. A stock upstream checkout to compare against, built the same way as the fork
git worktree add --detach ../rybbit-stock <upstream-commit>
for d in . ../rybbit-stock; do
  (cd "$d" && pnpm install --frozen-lockfile && pnpm --filter @rybbit/shared build \
    && (cd server && pnpm build) \
    && (cd client && NEXT_PUBLIC_BACKEND_URL=http://localhost:8080 pnpm build))
done
```

Phases: preflight (containers healthy, builds present, fork server built with `pnpm build` if stale) -> schema check
(aborts with a message if table `"user"` is missing; `--migrate` is the only thing that creates it) -> start stock
backend + client -> `bootstrap.mjs` (sign up admin, create org, site `demo-shop.example`, unrestricted org API key) ->
`generate-traffic.mjs --setup --live` -> BEFORE shots -> stop stock, start fork on the same DB (the restart promotes the
first user to admin) -> AFTER shots -> `make-report.mjs` -> stop servers (containers stay up).

Environment: `STOCK_DIR` (default `../rybbit-stock` next to the repo), `FORK_DIR` (repo root), `OUT_DIR`
(`scripts/demo/screenshots`), `ENV_FILE` (server env to source; default `scripts/demo/demo.env`, created from `demo.env.example` with a fresh `BETTER_AUTH_SECRET`), `BASE_URL` (`http://localhost:8080`, the proxy in front
of backend 3001 and client 3002), `VISITORS` (800), `DAYS` (30), `LIVE_MIN` (2), `WORK_DIR` (`/tmp/rybbit-demo`: logs, state),
`DEMO_EMAIL`/`DEMO_PASSWORD`/`DEMO_DOMAIN`, `SKIP_GENERATE=1` to reuse existing data.

`screenshots.mjs --phase before|after --site-id N` logs in through the UI and captures the same numbered list in both
phases (`before-03-pages.png` pairs with `after-03-pages.png`); hidden pages are opened by direct URL and shown as
rendered. One failing shot is logged and skipped. `manifest-<phase>.json` records each shot's final URL and page text.
Smoke test without an account: `node scripts/demo/screenshots.mjs --phase before --login-page-only --out /tmp/x`.
