# real-ana-be — API

Express 4 + Mongoose 9 + TypeScript (ESM: relative imports end in `.js`). This API is live with real users. Keep it fast and safe.

## Runtime facts that shape every decision

- **Deployed to Vercel serverless** (`api/index.ts`, `vercel.json`). Each instance is short-lived. In-memory state (caches, counters, queues) exists only per warm instance and can vanish at any time. Never depend on it for correctness. `src/index.ts` is only the local dev server; it also starts the in-process FX cron (`modules/billing/fx-cron.ts`), which never runs in production.
- **Scheduled work** runs through `/api/cron/*` (`http/routes/cron.ts`), called by Cloudflare Workers in `workers/*-cron` with `Authorization: Bearer CRON_SECRET`, not by Vercel Cron. Routes: `fx-sync`, `reports`, `reviews`, `social-posts` (also runs Alerts), `alerts`, `social-stats`, `backlinks`, `plan-expiry`, `event-retention`, and `run` for a manual run of everything. The Cloudflare account is at its trigger limit, so new work goes inside an existing route rather than a new worker. `.github/workflows/social-posts-cron.yml` is a 25-minute backup for `social-posts`.
- Responses are gzipped by `compression()` on `/api` and `/v1` (`src/app.ts`). Before adding any streaming or SSE response, exclude it from compression or flush explicitly.

## Structure

- `src/app.ts`: middleware order and route mounting.
- `src/http/routes/*`: thin handlers. They parse input, check access, call a service and respond.
- `src/modules/<domain>/`: services and `models/`. Business logic lives here.
- `src/modules/telegram/`:
  - `telegram.service.ts`: connection, chats, form alerts flag, own bot, test send, `deliveryFor`.
  - `telegram-updates.ts`: `/start <code>` and `/stop` from the Quantalog bot webhook.
  - `platform-webhook.ts`: registers the webhook.
  - `form-alert.ts`: da-forms alerts.

  Raw Bot API calls live in `infra/messaging/telegram.ts`. Reports and forms both send through `sendToChats`.
- `src/shared/utils/*`: generic helpers (`ttl-cache.ts`, `crypto-box.ts`, `forms-workspace-token.ts`, ...). `src/infra/*`: DB, mail, payments, storage, outbound HTTP (`infra/http-client/forms-service.ts` calls da-forms).
- `src/tracker/tracker.src.js` is the customer tracking script. `npm run build:tracker` (run by `dev` and `build`) writes `public/tracker.js`; never edit that file directly.
- Public and partner surfaces, all with open CORS where needed: `/api/track`, `/api/collect`, `/api/ingest` (ingest), `/v1` (public API, `http/routes/v1.ts`), `/api/share`, `/api/embed`, `/api/popups`, `/api/public/*`.
- `/api/internal/forms/*` (`http/routes/forms-internal.ts`) serves da-forms only, behind `Bearer FORMS_SERVICE_SECRET`: limits, branding, AI generate and edit (`modules/forms-ai`), bell notify, Telegram, WhatsApp, audit and submissions.
- The remote MCP server for Claude and ChatGPT is `/mcp` (`modules/mcp`) with OAuth at `/oauth`, `/.well-known` and `/api/oauth` (`modules/mcp-oauth`). All of it is off unless `MCP_ENABLED=true` (`requireMcpEnabled`). Details, scopes and tools are in `../CLAUDE.md` under Apps.
- Large JSON bodies get their own `express.json` limit in `app.ts` before the global parser (media, Orbit ask, social posts, avatar, form generate). Payment webhooks get `express.raw` so signatures verify.
- `scripts/`: one-off `tsx` scripts. App backfills run as `npm run backfill:<app>-app -- --write` (dry run without `--write`).

## Module map (`src/modules`)

| Module | What it owns |
|---|---|
| `analytics` | `Event`, `Site`, `Segment`, `Marker`, `Funnel`, `HeatmapClick`; `stats.service.ts` (`computeStats`, `resolveWindow`), bot detection, enrichment, live audience, retention, share cards |
| `workspace` | `Workspace`, `Membership`, `WorkspaceInvite`, `Project`; access checks, Quantalog app flags (`apps.service.ts`, `app-hooks.ts`), sidebar prefs, Home layout, workspace purge |
| `identity` | `User`, `Session`, API keys and their usage, Google login, pending signups, password resets, account deletion |
| `security` | Mongo-backed rate limits (`overRateLimit`, `RateCounter`), login attempt locks, identity re-confirmation |
| `billing` | Plan catalog, quotas and usage months, counted features, add-on packs, coupons, FX pricing and price locks, invoices, plan expiry reminders |
| `dashboards` | Custom dashboards (and the AI builder), public embeds, goal targets and their metrics, widget catalog |
| `reports` | Scheduled reports (`ReportSchedule`): runner, digest, HTML email, XLSX, Telegram and WhatsApp delivery |
| `alerts` | Quantalog Alerts: rules, checks, delivery, `AlertSettings`, `AlertEvent` |
| `notifications` | The bell (`Notification`), preferences, web push; send with `emit`, `emitTo`, `emitToMany` |
| `orbit`, `orbit-history` | Orbit AI (see below) and saved conversations |
| `forms-ai`, `form-alerts` | AI generate and edit for da-forms forms; form alerts to the bell and WhatsApp |
| `seo` | Site audits and crawls, Search Console, Compare (competitors, baselines, briefs), AI search checks, screenshots |
| `backlinks` | Backlink discovery, verification, link gap against competitors |
| `social` | Scheduled posts for `linkedin` and `instagram` (`POST_PROVIDERS`), post runner, stats refresh |
| `reviews` | Google Business Profile sync, with a Places API fallback (`places.service.ts`) |
| `telegram`, `whatsapp` | Messaging connections shared by reports, alerts and form alerts |
| `popups`, `media`, `notes`, `branding`, `referrals`, `audit`, `admin`, `onboarding-ai` | As named |
| `mcp`, `mcp-oauth` | The remote MCP connector for Claude and ChatGPT, see `../CLAUDE.md` |

## Access, plans and audit

- Workspace roles are `owner`, `admin`, `editor`, `viewer` (`ROLE_RANK` in `workspace/models/Membership.ts`). Pass the minimum role to `requireWorkspace(req, res, role)`. The role always comes from `Membership`, never from the token. App toggles need `admin`; minting the forms token needs `editor`.
- Platform admins use `requireAdmin` / `requireSuperAdmin` (`/api/admin`, dashboard `/app/admin-tools`). Impersonation and demo sessions use their own signed tokens (`signImpersonationToken`, `signDemoToken`); demo is read-only through `blockDemoWrites`.
- Plans are `free`, `starter` and `pro`, defined in `billing/plans.catalog.ts` (`getPlanCatalogEntry`). Each entry holds every limit and feature flag (forms, submissions, events, dashboards, embeds, goal targets, popups, report schedules, WhatsApp reports, alert interval, audit log days, ...). A new limit is a new field on every plan, never a hard-coded number in a route.
- Counted limits (dashboards, embeds, goal targets, popups) go through `COUNTED_FEATURES` in `billing/feature-limits.ts`. Monthly allowances go through `quota.service.ts`. Refuse with `planLimit(...)` from `http/plan-limit.ts` (402, `code` `quota_exceeded` or `plan_required`), whose shape the upgrade dialog and da-forms both rely on.
- Billing payments use Razorpay and Cashfree, with webhooks at `/api/webhooks/razorpay` and `/api/webhooks/cashfree` (raw bodies).
- Plans can auto-renew through Razorpay Subscriptions (`modules/billing/auto-renew.ts`). Every `subscription.charged` creates its own `PlanPurchase` row, de-duplicated by `chargeId` (the Razorpay payment id), and sets the period end to Razorpay's next charge date plus 3 days. A coupon discounts only the first (upfront) charge, which never goes below ₹1 (`MIN_CHARGE`), so a 100% coupon charges ₹1 instead of Razorpay's refundable ₹5 authorisation. Add-on packs and Cashfree are one-time only. Deleting a workspace cancels its Razorpay subscription. A downgrade is only possible as a scheduled switch: a new subscription for the lower plan starting at `currentPeriodEnd`, which cancels the old one when adopted (`renewalPlanSlug`/`renewalCycle` record what the workspace renews into). Subscription webhook failures return 500 so Razorpay retries, and the daily `plan-expiry` cron runs `reconcileRenewals` to credit any paid invoice a webhook missed.
- Paid Quantalog apps (`modules/billing/paid-apps.catalog.ts`: Notes, Reviews, Alerts, Links, Link-in-bio, Popups) are a one-time unlock per workspace, ₹599 by default. Prices live in `AppPrice` (INR is the base; the FX reprice derives USD and reports apps in its email). `POST /api/billing/apps/:appId/purchase` opens an order, `AppPurchase` is credited by the shared confirm and webhook path, and `unlockApp` sets `apps.<id>.paidAt` and turns the app on. `PUT /workspaces/:wid/apps/:appId` refuses to enable a locked paid app with 402 `app_payment_required`. A workspace that had turned an app on before it became paid (`enabledAt` set) keeps it free.
- Orbit AI is included in every analytics plan (`ORBIT_TIER_BY_PLAN` in `modules/orbit/orbit-host.ts`). Orbit tiers are not sold separately.
- `auditTrail` on `/api/workspaces/:wid` records every mutating request. `modules/audit/route-registry.ts` gives routes a named action and a "before" snapshot; `action: null` skips one. Register new write routes there.
- Rate limits that must hold across serverless instances use `overRateLimit` from `modules/security/rate-limit.service.ts`, not an in-memory counter.

## Orbit AI

- `modules/orbit` answers questions (`askOrbit`) from a docs corpus (`corpus.ts`, `retrieval.ts`) and workspace data (`orbit-data-*.ts` for traffic, forms, reviews and SEO). `prompt-public.ts` serves the public `/api/public/orbit` assistant on the landing page.
- Models are listed in `orbit/models.ts` with a provider (`gemini`, `openrouter`, `nvidia`, `cloudflare`) and a tier (`basic`, `standard`, `advanced`). Only the Cloudflare Llama models are active now.
- The core is meant to become a standalone package: plan and quota questions go through `OrbitHost` (`types.ts`), implemented by `orbit-host.ts`. Don't import billing or plan code anywhere else in the module.
- Orbit routes accept a session or an API key (`requireApiKeyOrAuth`), which is how the Chrome extension calls them.

## Public API (`/v1`)

`http/routes/v1.ts`, authenticated with workspace API keys (`requireApiKey`, keys hashed and expiring, usage tracked in `ApiKeyUsage`). It covers projects, sites, stats, the tracking snippet, markers, app-user tracking and reviews. OpenAPI docs live in `http/openapi`. Treat it like any public API: never change an existing response shape.

## What every workspace request already pays

`requireAuth` (Session lookup) → `requireUnlocked` (User `lockedAt`) → `resolveAccess` (Membership + Workspace, run in parallel). These lookups are the floor:

- Don't add more database lookups to the middleware.
- Get workspace access through `resolveAccess` / `requireWorkspace` from `modules/workspace/access.service.ts`, then use the `workspace` it returns. Don't query the workspace again.
- Non-members get **404**, never 403, so workspace ids can't be enumerated.

## Query rules

1. **Run independent awaits together with `Promise.all`.** Await in sequence only when a step needs the previous result. The `/:wid/stats` route shows the pattern.
2. **No N+1.** Never `await` a query inside a loop or `.map`. Batch with `$in`, then join in memory.
3. **Fetch only what you need.** Use `.select()` for the fields used. Use `.lean()` for read-only results that go straight into JSON. Bound every list with a limit or cursor pagination.
4. **Stay on indexes.** `Event` is the large collection. Its indexes are `{siteId, ts}`, `{siteId, type, ts}`, `{siteId, appUserId, ts}` and `{siteId, installId}`.
   - Every Event query or `$match` starts with `siteId` (`$in` is fine) plus a `ts` range.
   - Put `$match` first in a pipeline, then `$project` and `$group`.
   - A new query shape that doesn't fit an existing index needs a new index in the model. Say so in your final message.
5. **Keep heavy work out of hot paths.**
   - `quotaSummary` is expensive (rolls the usage month, runs several queries, does a dynamic import). Don't call it per request outside billing and usage routes. `GET /api/workspaces` already includes it per workspace.
   - `computeStats` runs about 30 aggregations. Never call it from an endpoint that is polled on a short interval.
6. **Polled endpoints stay cheap:** `/:wid/live` (polled every 10s) and `/api/notifications/unread-count` (every 30s) only read small time windows or counts.
7. **Ingest paths** (`/api/collect`, `/api/ingest`, `/api/track`) carry customer traffic. Keep each one to the minimum write. Never make them wait on mail, AI, or other non-essential calls.

## Caching

- Use `createTtlCache(ttlMs, maxEntries)` from `src/shared/utils/ttl-cache.ts`. It caches the promise, so concurrent identical requests share one computation, and failures are evicted.
- Current caches:
  - stats payload: 10s (`http/routes/workspaces.ts`)
  - goal-target readings: 60s
  - embeds (`modules/dashboards/embed.service.ts`)
- **The cache key must include every input that changes the output:** workspace id, site ids, range, filters, compare mode, custom dates, and relevant definitions such as goals.
- **Never cache** authentication, session, lock or membership checks. Revocation and role changes must take effect immediately.
- **Never share** a cache entry across users or workspaces. The workspace id or user id always goes in the key.
- Keep TTLs short (seconds) for live analytics. The dashboard polls and expects reasonably fresh numbers.

## Response rules

- Return only what the client renders. No whole documents with large or private fields. No secrets, tokens or credentials in responses.
- Keep response shapes stable. The frontend's RTK Query cache and `bootPrefetch.ts` depend on them. Coordinate any shape change with `real-ana-fe`.
- Errors return JSON `{ error }` with an accurate status code. Plan limits go through `planLimit(...)`. Demo sessions are read-only (`blockDemoWrites`).
- `express-async-errors` (first import in `app.ts`) sends errors thrown in async routes to `errorHandler`. So `throw`, or let failures bubble up; never swallow them silently. `errorHandler` reports 5xx errors through `src/infra/monitoring/sentry.ts`, which does nothing without `SENTRY_DSN`. Use `captureServerError` to report any other unexpected failure.
- Security headers come from `helmet` in `app.ts`, with cross-origin resource sharing allowed because `tracker.js`, embeds and OAuth popups are used from other origins. Don't tighten `crossOriginResourcePolicy` or `crossOriginOpenerPolicy` without checking those flows.
- Never put a real secret in `.env.example`. Use placeholders only.

## Coding rules

1. No comments in code files.
2. Routes stay thin. Logic goes in `modules/<domain>`. Reuse existing services and helpers before writing new ones.
3. Split code into services, models and utilities. Never put a whole feature in one file.

## Checklist before saying a change is done

- [ ] Independent awaits are parallel. No N+1.
- [ ] Event queries use `siteId` and a `ts` range on an index. New query shapes have an index.
- [ ] Nothing heavy was added to a polled or ingest endpoint, or to the middleware chain.
- [ ] Any cache key covers every input. No auth or cross-tenant caching.
- [ ] Nothing relies on in-memory state surviving between serverless invocations.
- [ ] New scheduled work runs inside an existing `/api/cron` route, not a new worker.
- [ ] Changes to `/api/internal/forms/*` or the forms token are matched in `da-forms`.
- [ ] Response shape changes are coordinated with the frontend.
