#!/usr/bin/env node
/**
 * Demo bootstrap: creates (or re-uses) the demo admin account, organization, site and API key through
 * the public HTTP API, and prints one JSON object {orgId, siteId, apiKey, domain} on stdout.
 * Logs go to stderr. Used by run-demo.sh; idempotent (signs in if the account already exists).
 *
 * Env: BASE_URL (default http://localhost:8080), DEMO_EMAIL, DEMO_PASSWORD, DEMO_DOMAIN, STATE_FILE
 * The cookie jar is handled by hand because the session cookie is marked Secure (NODE_ENV=production)
 * while the demo runs on plain http://localhost.
 */
import { existsSync, readFileSync } from "node:fs";

const BASE = (process.env.BASE_URL || "http://localhost:8080").replace(/\/+$/, "");
const EMAIL = process.env.DEMO_EMAIL || "demo@lumenly.example";
const PASSWORD = process.env.DEMO_PASSWORD || "Demo-Pass-12345!";
const DOMAIN = process.env.DEMO_DOMAIN || "demo-shop.example";
const STATE_FILE = process.env.STATE_FILE || "";

const log = (...a) => console.error("[bootstrap]", ...a);
const jar = new Map();

async function api(method, path, body, extraHeaders = {}) {
  const headers = {
    Origin: BASE,
    "Content-Type": "application/json",
    Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    ...extraHeaders,
  };
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (/max-age=0/i.test(c) || value === "") jar.delete(name);
    else jar.set(name, value);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

function fail(msg, r) {
  console.error(`[bootstrap] FAILED: ${msg}${r ? ` (HTTP ${r.status}: ${r.text.slice(0, 300)})` : ""}`);
  process.exit(1);
}

// 1. account: sign up, or sign in when it already exists
let r = await api("POST", "/api/auth/sign-up/email", { email: EMAIL, name: EMAIL.split("@")[0], password: PASSWORD });
if (r.ok) log(`signed up ${EMAIL}`);
else {
  log(`sign-up not accepted (HTTP ${r.status}), trying sign-in`);
  r = await api("POST", "/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD });
  if (!r.ok) fail("neither sign-up nor sign-in worked", r);
  log(`signed in ${EMAIL}`);
}
if (jar.size === 0) fail("no session cookie received", r);

// 2. organization (the web signup names it after the domain)
r = await api("GET", "/api/auth/organization/list");
let org = Array.isArray(r.json) ? r.json[0] : null;
if (!org) {
  r = await api("POST", "/api/auth/organization/create", { name: DOMAIN, slug: DOMAIN.replace(/[^a-z0-9]+/gi, "-").toLowerCase() });
  if (!r.ok || !r.json?.id) fail("organization create", r);
  org = r.json;
  log(`created organization ${org.id}`);
} else log(`using organization ${org.id}`);
r = await api("POST", "/api/auth/organization/set-active", { organizationId: org.id });
if (!r.ok) log(`set-active returned HTTP ${r.status} (continuing)`);

// 3. site
r = await api("GET", `/api/organizations/${org.id}/sites`);
if (!r.ok) fail("list sites", r);
const sites = Array.isArray(r.json) ? r.json : (r.json?.sites ?? r.json?.data ?? []);
let site = sites.find(s => s.domain === DOMAIN);
if (!site) {
  r = await api("POST", `/api/organizations/${org.id}/sites`, { domain: DOMAIN, name: DOMAIN });
  if (!r.ok || r.json?.siteId == null) fail("site create", r);
  site = r.json;
  log(`created site ${site.siteId} (${DOMAIN})`);
} else log(`using site ${site.siteId} (${DOMAIN})`);

// 4. API key. The generator needs sites:write, goals:write, funnels:write (and ingest:write for --trusted).
// An org key minted without `permissions` is unrestricted, which covers all of these. Keys cannot be re-read
// after creation, so a previous run's key is re-used from the state file when present.
let apiKey = "";
if (STATE_FILE && existsSync(STATE_FILE)) {
  try {
    const prev = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (prev.siteId === site.siteId && prev.apiKey) apiKey = prev.apiKey;
  } catch {}
}
if (apiKey) {
  // verify it still works
  const chk = await fetch(`${BASE}/api/sites/${site.siteId}/imports`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!chk.ok) apiKey = "";
  else log("re-using API key from state file");
}
if (!apiKey) {
  r = await api("POST", `/api/organizations/${org.id}/api-keys`, { name: "demo-traffic-generator" });
  if (!r.ok || !r.json?.key) fail("api key create", r);
  apiKey = r.json.key;
  log("created API key");
}

console.log(JSON.stringify({ orgId: org.id, siteId: site.siteId, apiKey, domain: DOMAIN, email: EMAIL }));
