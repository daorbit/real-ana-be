# Quantalog API

The backend for [Quantalog](https://quantalog.daorbit.in): privacy-first, real-time web analytics with SEO audits, scheduled reports, social posting, forms and the Orbit AI assistant.

- **Stack:** Node.js 22, Express 4, Mongoose 9 (MongoDB Atlas), TypeScript (ESM)
- **Production:** `https://quantalog-be.daorbit.in`, deployed to Vercel as a serverless function
- **API reference:** `/docs` (Swagger UI) and `/openapi.json`
- **Product docs:** https://quantalog.daorbit.in/docs

## Getting started

```bash
npm install
cp .env.example .env
npm run dev
```

The API listens on `http://localhost:4000`. Check it's up with `GET /api/health`.

For a local run you need at least `MONGODB_URI`, `JWT_SECRET` and `PUBLIC_BASE_URL` in `.env`. Add the variables for any integration you want to test locally (payments, mail, Cloudinary, LinkedIn, Search Console, AI).

To run the API together with the dashboard and landing site, run `npm run dev` from the parent `real-time-analytics` folder.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Builds the tracker, then runs the API with hot reload (`tsx watch`) |
| `npm run build` | Builds the tracker and compiles TypeScript to `dist/` |
| `npm run start` | Builds, then runs `dist/index.js` |
| `npm run build:tracker` | Rebuilds `public/tracker.js` from `src/tracker` |
| `npm run backfill:events` | One-off: recounts event usage per workspace |
| `npm run report:media-over-cap` | Lists workspaces whose media library is over its cap |

## Project structure

```
api/index.ts          Vercel serverless entry (connects to the DB, then hands off to Express)
src/index.ts          Local dev server
src/app.ts            Middleware order and route mounting
src/http/routes/      Thin route handlers: parse input, check access, call a service
src/http/middleware/  Auth, CORS, API keys, error handling
src/modules/<domain>/ Business logic and Mongoose models (analytics, billing, seo, orbit, ...)
src/infra/            Database, mail, payments, storage, messaging, outbound HTTP
src/shared/           Generic utilities and error types
src/tracker/          Source of the public tracker.js script
workers/              Cloudflare Workers that trigger the cron routes on a schedule
scripts/              One-off maintenance and seeding scripts
```

## Environment variables

`.env.example` lists every variable. The groups:

| Area | Variables |
|---|---|
| Core | `MONGODB_URI`, `JWT_SECRET`, `PORT`, `PUBLIC_BASE_URL`, `STUDIO_BASE_URL`, `TOKEN_ENCRYPTION_KEY` |
| Mail | `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_FROM_NAME` |
| Payments | `RAZORPAY_*`, `INVOICE_SELLER_*`, `EXCHANGERATE_API_KEY`, `FX_*` |
| Media | `CLOUDINARY_*`, `ORBIT_WATERMARK_PUBLIC_ID` |
| Sign-in | `GOOGLE_CLIENT_ID`, `GIT_CLIENT_ID`/`GIT_CLIENT_SECRET`, `LINKEDIN_*`, `CLOUDFLARE_SECRET_KEY` (Turnstile) |
| Integrations | `GOOGLE_GSC_*`, `INSTAGRAM_*`, `META_*`, `WIREWEB_*` (WhatsApp), `DATAFORSEO_*`, `GOOGLE_PAGESPEED_API_KEY` |
| AI | `CLAUDE_*`, `GEMINI_API_KEY` |
| Scheduled jobs | `CRON_SECRET` |
| Monitoring | `SENTRY_DSN`, `SENTRY_ENVIRONMENT` (optional; error tracking is off when unset) |

Never commit real values. `.env` is ignored by git; `.env.example` holds placeholders only.

## Deployment

- **API:** deployed to Vercel (`vercel.json` routes all traffic to `api/index.ts`). Set the environment variables in the Vercel project settings.
- **Scheduled jobs:** each folder in `workers/` is a small Cloudflare Worker whose cron trigger calls an `/api/cron/*` route with `CRON_SECRET`. Deploy them with `npx wrangler deploy` from the worker's folder. The social-posts schedule also runs from `.github/workflows/social-posts-cron.yml`.

## Conventions

- Workspace routes check access through `resolveAccess` / `requireWorkspace`. Non-members get a 404.
- Independent database calls run in parallel. Large reads are bounded, use indexes, and cache briefly with `createTtlCache` where it helps.
- Errors from async routes reach the central error handler (`express-async-errors`), which reports 5xx errors to Sentry when it's configured.
- `CLAUDE.md` holds the full performance and coding rules for this codebase. Read it before making changes.
