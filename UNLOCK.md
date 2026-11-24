# rybbit-unlocked: cloud features without cloud billing

Upstream gates several finished features on `IS_CLOUD` (`CLOUD=true` / `NEXT_PUBLIC_CLOUD=true`). That same flag
also turns on Stripe, plan gating, quotas, usage enforcement (sites without a paid plan stop ingesting),
Turnstile, AppSumo and affiliate prompts, so it cannot be enabled on a self-hosted install.

This fork adds a second flag:

| Constant | Server | Client | Default |
| --- | --- | --- | --- |
| `UNLOCK_CLOUD_FEATURES` | `UNLOCK_CLOUD_FEATURES` | `NEXT_PUBLIC_UNLOCK_CLOUD_FEATURES` | on (anything except `"false"`) |
| `CLOUD_FEATURES` | `IS_CLOUD \|\| UNLOCK_CLOUD_FEATURES` | same | |

Rule: feature gates use `CLOUD_FEATURES`; billing and commercial gates keep `IS_CLOUD`.
`docker-compose.yml` passes `UNLOCK_CLOUD_FEATURES` to the backend and, as a build arg and env var, to the client.
The client value is baked in at build time, so changing it needs a client rebuild.

## Turning it off

Set `UNLOCK_CLOUD_FEATURES=false` in `.env` and rebuild the client (`docker compose up -d --build`). Behavior then
matches upstream self-hosted.

## Unlocked gates

| File | Controls | Why unlocked | Runtime needs |
| --- | --- | --- | --- |
| `client/src/app/[site]/components/Sidebar/Sidebar.tsx` | Pages, Bots, Performance items; Explore header; Query, Dashboards | Backend routes are not gated; pure analytics views | none |
| `client/src/components/command-palette/usePaletteCommands.tsx` | Same sections in the command palette; dashboards fetch | Mirrors the sidebar. Billing entry (`IS_CLOUD && can("billing:manage")`) left alone | none |
| `client/src/components/AppSidebar.tsx` | Admin link (`!CLOUD_FEATURES && !DEPLOYMENT`) | Admin routes already exist server-side behind `systemAdmin` | system admin user |
| `client/src/components/SiteSettings/TrackingTab.tsx` | Web Vitals toggle visibility | Plan checks (`&& IS_CLOUD`) already allow everything on self-host | none |
| `client/src/app/components/AddSite.tsx` | Web Vitals toggle in the add-site dialog | Same | none |
| `client/src/components/SiteSettings/SiteSettings.tsx` | Integrations tab (Google Search Console) | Server GSC routes are not gated | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, optional `GOOGLE_REDIRECT_URI` |
| `client/src/app/[site]/main/page.tsx` | Search Console card on the main dashboard | Same | same |
| `client/src/app/[site]/components/shared/StandardSection/StandardSection.tsx` | "Geolocation by MaxMind" tooltip on Countries, Regions, Cities | Self-hosted also uses a GeoLite2 database; attribution is accurate | none |
| `client/src/app/[site]/globe/globeStore.ts` | 3D globe as the default map mode | Works with a Mapbox token | `MAPBOX_TOKEN` |
| `client/src/app/settings/account/components/AccountInner.tsx` | Weekly email reports toggle | Server cron and mailer now run when email is configured | `RESEND_API_KEY` |
| `server/src/index.ts`, `server/src/cluster.ts` | Weekly report cron start/stop | Split from `lifecycleEmailService` so only reports run; lifecycle marketing stays on `IS_CLOUD` | `RESEND_API_KEY` |
| `server/src/services/weekyReports/weeklyReportService.ts` | Report generation and cron init | Contains no billing logic | `RESEND_API_KEY` |
| `server/src/lib/email/email.ts` | Email transport (Resend) | Created when `IS_CLOUD`, or `CLOUD_FEATURES` and `RESEND_API_KEY` set. Unset means `sendEmail` is a silent no-op, as before | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` |

### Graceful degradation added

- Weekly reports: `generateAndSendReports` skips when no email provider is configured (`isEmailConfigured()`), so no queries run for nothing.
- Email sender: `EMAIL_FROM` / `EMAIL_REPLY_TO` override the hard-coded `email.rybbit.com` sender, which self-hosters cannot use with their own Resend account.
- Search Console: `GET /sites/:id/gsc/status` now returns `oauthConfigured`. The settings tab and dashboard card show "not configured on this server" instead of a Connect button that fails (`GSCManager.tsx`, `SearchConsole.tsx`).
- 3D globe: `globe/page.tsx` falls back to 2D when the server has no Mapbox token.

### Side effect to know about

With `RESEND_API_KEY` set on a self-hosted install, the other transactional emails that were silent no-ops
(OTP, email verification, invitations, site-transfer emails) are also sent. Their own gates are unchanged.

## Already working on self-host, nothing changed

- PDF export (`generatePdfReport.ts:35`): `!IS_CLOUD` already means "allowed"; the check is a plan gate. Needs Chromium/puppeteer in the backend image.
- Session replay and web vitals plan checks (`... && IS_CLOUD`) already allow everything.
- No backend route, pages API, bot pipeline or web vitals ingestion path is gated on `IS_CLOUD`.

## Reviewed and left gated (`IS_CLOUD`)

Full line-by-line list with reasons: `fork/is-cloud-allowlist.txt`.

| Reason | Where |
| --- | --- |
| billing | Stripe routes, DPA routes (`api/routes.ts`); `subscriptionUtils`, `useStripeSubscription`, `InvoicesSection`, billing/DPA entries in `NavigationSidebar` and the command palette, subscription badge in `AppSidebar`; `usageService`, `getSiteUsage`, `getSitesFromOrg`; `DisabledOverlay`; `(home)/page.tsx` plan screen; PDF plan gate; `EnableSessionReplay` |
| quota | Site, member and API-key limits (`siteLimit`, `memberLimits`, `apiKeyLimits`, `createApiKey`, `createOrgApiKey`, `ApiKeyManager`); rate limits (`apiRateLimit*`, `mcp/auth.ts`, `getOrgApiUsage`); import quotas and import endpoints (`importQuota*`, `*SiteImport*`, `batchImportEvents`, `ImportManager`, `useImport`); `siteConfigurationLifecycle` plan checks; plan toggles in `TrackingTab` and `AddSite` |
| signup | Turnstile, signup steps, referral prompts, claim-site dialog, affiliate banner, AppSumo (`api/as/*`, `as/callback`), social buttons, invite flow, `auth.ts`, `auth-utils.ts`, `siteTransfers` `emailVerified`, `try/page.tsx` |
| telemetry | `telemetryService`, `collectTelemetry`, `Providers.tsx` own-analytics |
| commercial-ui | `Footer`, `VersionCheck`, `lifecycleEmailService` and its cron start/stop, `r2StorageService` (also needs R2 credentials; session replay already works locally), `generatePdfReport` plan gate, `admin/page.tsx` (commented out) |
| cloud-infra | `const.ts` definitions, `initializeCloudTables` (usage materialized view), AppSumo tables in `initPostgres` |

## After an upstream merge

Run a grep for `IS_CLOUD` in `client/src` and `server/src` (non-test files) and diff the trimmed lines against
`fork/is-cloud-allowlist.txt`. Any line not listed is new: decide feature (`CLOUD_FEATURES`) or billing (add to the allowlist).

Fork edits are limited to the files above, the graceful-degradation files (`api/gsc/status.ts`, `GSCManager.tsx`, `SearchConsole.tsx`, `globe/page.tsx`, GSC endpoint type), `.env.example`, `docker-compose.yml`, `client/Dockerfile`, `client/next.config.ts`, and three test files (`CommandPalette.test.tsx`, `weeklyReportService.test.ts`, `email.test.ts`) whose mocks were adjusted.
