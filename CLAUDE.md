# real-ana-be — API

Express 4 + Mongoose 9 + TypeScript (ESM: relative imports end in `.js`). This API is live with real users. Keep it fast and safe.

## Runtime facts that shape every decision

- **Deployed to Vercel serverless** (`api/index.ts`, `vercel.json`). Each instance is short-lived. In-memory state (caches, counters, queues) exists only per warm instance and can vanish at any time. Never depend on it for correctness. Scheduled work runs through `/api/cron` (Vercel Cron), not in-process timers. `src/index.ts` is only the local dev server.
- Responses are gzipped by `compression()` on `/api` and `/v1` (`src/app.ts`). Before adding any streaming or SSE response, exclude it from compression or flush explicitly.

## Structure

- `src/app.ts`: middleware order and route mounting.
- `src/http/routes/*`: thin handlers. They parse input, check access, call a service and respond.
- `src/modules/<domain>/`: services and `models/`. Business logic lives here.
- `src/shared/utils/*`: generic helpers (`ttl-cache.ts`, `crypto-box.ts`, ...). `src/infra/*`: DB, mail, payments, storage, outbound HTTP.

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
- [ ] Response shape changes are coordinated with the frontend.
