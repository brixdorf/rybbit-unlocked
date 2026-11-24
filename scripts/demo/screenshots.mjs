#!/usr/bin/env node
/**
 * Playwright screenshots for the before/after demo.
 *
 *   node scripts/demo/screenshots.mjs --phase before|after --site-id 1 [--out dir]
 *   node scripts/demo/screenshots.mjs --phase before --login-page-only --out /tmp/x   (smoke test, no account needed)
 *
 * Env (flags win): BASE_URL (http://localhost:8080), SITE_ID, DEMO_EMAIL, DEMO_PASSWORD, OUT_DIR, SETTLE_MS (2500),
 * DEMO_SQL (the query run on the Query page).
 *
 * The same list of shots runs in both phases, so before-NN-x.png pairs with after-NN-x.png. Nothing here
 * assumes a feature exists: a page that is hidden, redirected or broken is captured as it is and noted in
 * manifest-<phase>.json (final URL, status, first words of the page). One failing shot never stops the run.
 * `require('playwright')` is resolved from the global/NODE_PATH install, then from the cwd.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) o[k] = true;
    else {
      o[k] = next;
      i++;
    }
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));

const PHASE = String(args.phase || "before");
const BASE = String(args["base-url"] || process.env.BASE_URL || "http://localhost:8080").replace(/\/+$/, "");
const SITE = String(args["site-id"] || process.env.SITE_ID || "");
const EMAIL = process.env.DEMO_EMAIL || "demo@lumenly.example";
const PASSWORD = process.env.DEMO_PASSWORD || "Demo-Pass-12345!";
const OUT = path.resolve(String(args.out || process.env.OUT_DIR || "scripts/demo/screenshots"));
const SETTLE = Number(process.env.SETTLE_MS || 2500);
const SQL =
  process.env.DEMO_SQL ||
  "SELECT country, count() AS pageviews, uniq(user_id) AS visitors\nFROM scoped_events\nWHERE type = 'pageview'\nGROUP BY country\nORDER BY pageviews DESC\nLIMIT 10";
const LOGIN_ONLY = !!args["login-page-only"];

if (!["before", "after"].includes(PHASE)) {
  console.error("--phase must be before or after");
  process.exit(2);
}
if (!LOGIN_ONLY && !/^\d+$/.test(SITE)) {
  console.error("--site-id (or SITE_ID) must be the numeric site id");
  process.exit(2);
}

function loadPlaywright() {
  for (const base of [import.meta.url, path.join(process.cwd(), "noop.js")]) {
    try {
      return createRequire(base)("playwright");
    } catch {}
  }
  console.error("Cannot load playwright (npm i -g playwright, or set NODE_PATH)");
  process.exit(2);
}
const { chromium } = loadPlaywright();

mkdirSync(OUT, { recursive: true });
const manifest = [];
const log = (...a) => console.log(`[screenshots:${PHASE}]`, ...a);

const VIEWPORT = { width: 1440, height: 900 };
let page;

async function settle(extra = 0) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {}
  await page.waitForTimeout(SETTLE + extra);
  // charts and tables load after the first idle (react-query follow-ups): one more short idle wait
  try {
    await page.waitForLoadState("networkidle", { timeout: 5000 });
  } catch {}
}

/** Close tours / onboarding / welcome dialogs / cookie banners if any show up. Best effort, never throws. */
async function dismissOverlays() {
  const labels = [/^skip/i, /^got it/i, /^dismiss/i, /^maybe later/i, /^not now/i, /^no thanks/i, /^close$/i];
  for (let round = 0; round < 2; round++) {
    const dialog = page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').first();
    if (!(await dialog.count().catch(() => 0))) return;
    let clicked = false;
    for (const re of labels) {
      const btn = dialog.getByRole("button", { name: re }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 2000 }).catch(() => {});
        clicked = true;
        break;
      }
    }
    if (!clicked) await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function snippet() {
  try {
    const t = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim());
    return t.slice(0, 240);
  } catch {
    return "";
  }
}

/** Run one shot; log and record the outcome; never throw. */
async function shot(id, slug, caption, fn) {
  const file = `${PHASE}-${id}-${slug}.png`;
  const entry = { id, slug, file, caption, status: "ok", url: "", note: "", text: "" };
  try {
    const result = await fn(path.join(OUT, file));
    if (result && result.skipped) {
      entry.status = "absent";
      entry.note = result.skipped;
      entry.file = "";
    }
  } catch (e) {
    entry.status = "error";
    entry.note = String(e?.message || e).split("\n")[0];
    entry.file = "";
    // an error mid-way may leave a modal open or a shrunk viewport
    await page.keyboard.press("Escape").catch(() => {});
    await page.setViewportSize(VIEWPORT).catch(() => {});
  }
  try {
    entry.url = page.url().replace(BASE, "");
    entry.text = await snippet();
  } catch {}
  manifest.push(entry);
  log(`${entry.status.padEnd(6)} ${file}${entry.note ? `  (${entry.note})` : ""}  -> ${entry.url}`);
}

async function go(urlPath, extraSettle = 0) {
  await page.goto(`${BASE}${urlPath}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await settle(extraSettle);
  await dismissOverlays();
}

async function openSiteSettings() {
  await go(`/${SITE}/main`);
  const trigger = page.getByRole("button", { name: /^\s*Site Settings\s*$/ }).first();
  if (!(await trigger.isVisible().catch(() => false))) throw new Error('"Site Settings" button not found in sidebar');
  await trigger.click({ timeout: 5000 });
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(1200);
  return dialog;
}

async function clickSettingsTab(dialog, label) {
  const tab = dialog.locator("aside button").filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
  if (!(await tab.isVisible().catch(() => false))) return false;
  await tab.click({ timeout: 5000 });
  await page.waitForTimeout(1500);
  return true;
}

async function fullPage(file, extraSettle = 0) {
  await settle(extraSettle);
  await page.screenshot({ path: file, fullPage: true });
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: "dark" });
  page = await context.newPage();
  page.setDefaultTimeout(20000);

  // ---- login ------------------------------------------------------------
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await settle();
  if (LOGIN_ONLY) {
    await shot("00", "login-page", "Login page", async f => {
      await page.screenshot({ path: f });
    });
    writeFileSync(path.join(OUT, `manifest-${PHASE}.json`), JSON.stringify(manifest, null, 2));
    await browser.close();
    return;
  }
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await Promise.all([
    page.waitForURL(u => !u.pathname.startsWith("/login"), { timeout: 30000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
  await settle();
  log(`logged in as ${EMAIL}, landed on ${page.url().replace(BASE, "")}`);

  // ---- shots (same list in both phases) ---------------------------------
  await shot("01", "main-dashboard", "Main dashboard, full page", async f => {
    await go(`/${SITE}/main`, 2000);
    await fullPage(f);
  });

  await shot("02", "sidebar", "Site sidebar and app rail (which sections are offered)", async f => {
    await go(`/${SITE}/main`);
    await page.setViewportSize({ width: 1440, height: 1300 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: f, clip: { x: 0, y: 0, width: 300, height: 1300 } });
    await page.setViewportSize(VIEWPORT);
  });

  for (const [id, slug, route, caption] of [
    ["03", "pages", "pages", "Pages (direct URL)"],
    ["04", "bots", "bots", "Bots (direct URL)"],
    ["05", "performance", "performance", "Performance / Web Vitals (direct URL)"],
  ]) {
    await shot(id, slug, caption, async f => {
      await go(`/${SITE}/${route}`, 2500);
      await fullPage(f);
    });
  }

  await shot("06", "query", "Query page (direct URL)", async f => {
    await go(`/${SITE}/query`);
    await page.screenshot({ path: f });
  });

  await shot("07", "query-results", "Query page after running a sample SQL query", async f => {
    await go(`/${SITE}/query`);
    const ta = page.locator("textarea").last();
    if (!(await ta.isVisible().catch(() => false))) throw new Error("no query editor on this page");
    await ta.click();
    await ta.fill(SQL);
    const run = page.getByRole("button", { name: /^\s*Run\s*$/ }).first();
    await run.click({ timeout: 5000 });
    await page.waitForTimeout(500);
    try {
      await page.locator("table tbody tr").first().waitFor({ state: "visible", timeout: 25000 });
    } catch {
      log("  no result rows appeared (error banner or empty result is captured as is)");
    }
    await page.waitForTimeout(1000);
    await page.screenshot({ path: f });
  });

  await shot("08", "dashboards", "Dashboards (direct URL)", async f => {
    await go(`/${SITE}/dashboards`);
    await page.screenshot({ path: f });
  });

  await shot("09", "globe", "Globe", async f => {
    await go(`/${SITE}/globe`, 4000);
    await page.screenshot({ path: f });
  });

  // Site settings dialog: tall viewport so the whole dialog (80vh) is visible
  await shot("10", "settings-tabs", "Site Settings dialog, left rail (list of tabs)", async f => {
    await page.setViewportSize({ width: 1440, height: 1300 });
    const dialog = await openSiteSettings();
    await dialog.screenshot({ path: f });
  });
  await shot("11", "settings-tracking", "Site Settings, Tracking tab (feature toggles)", async f => {
    let dialog = page.locator('[role="dialog"]').first();
    if (!(await dialog.isVisible().catch(() => false))) {
      await page.setViewportSize({ width: 1440, height: 1300 });
      dialog = await openSiteSettings();
    }
    if (!(await clickSettingsTab(dialog, "Tracking"))) throw new Error("Tracking tab not found");
    await dialog.screenshot({ path: f });
  });
  await shot("12", "settings-integrations", "Site Settings, Integrations tab (Search Console)", async f => {
    const dialog = page.locator('[role="dialog"]').first();
    if (!(await dialog.isVisible().catch(() => false))) throw new Error("settings dialog is not open");
    if (!(await clickSettingsTab(dialog, "Integrations"))) return { skipped: "no Integrations tab in this build" };
    await dialog.screenshot({ path: f });
  });
  await page.keyboard.press("Escape").catch(() => {});
  await page.setViewportSize(VIEWPORT).catch(() => {});

  await shot("13", "account-preferences", "Account settings (Preferences, weekly email reports)", async f => {
    await go("/settings/account", 1500);
    await fullPage(f);
  });

  await shot("14", "admin", "Admin area (direct URL)", async f => {
    await go("/admin", 2500);
    await page.screenshot({ path: f });
  });

  await shot("15", "rail-admin-link", "App rail, bottom: is there an Admin link?", async f => {
    await go(`/${SITE}/main`);
    const adminLink = page.getByRole("link", { name: "Admin", exact: true });
    const visible = await adminLink.first().isVisible().catch(() => false);
    log(`  Admin link in rail: ${visible ? "present" : "absent"}`);
    manifest.push({ id: "15a", slug: "admin-link-present", file: "", caption: "Admin link in app rail", status: visible ? "present" : "absent", url: "", note: "", text: "" });
    await page.screenshot({ path: f, clip: { x: 0, y: 0, width: 80, height: 900 } });
  });

  writeFileSync(path.join(OUT, `manifest-${PHASE}.json`), JSON.stringify(manifest, null, 2));
  await browser.close();
  const bad = manifest.filter(m => m.status === "error").length;
  log(`done: ${manifest.filter(m => m.status === "ok").length} screenshots, ${manifest.filter(m => m.status === "absent").length} absent, ${bad} errors -> ${OUT}`);
}

main().catch(e => {
  console.error(`[screenshots:${PHASE}] fatal:`, e);
  try {
    writeFileSync(path.join(OUT, `manifest-${PHASE}.json`), JSON.stringify(manifest, null, 2));
  } catch {}
  process.exit(1);
});
