import express, { Request, Response } from "express";
import cors from "cors";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";
import { TRACKER_VERSION } from "./modules/analytics/stats.service.js";
import authRoutes from "./http/routes/auth.js";
import linkedinRoutes from "./http/routes/linkedin.js";
import instagramRoutes from "./http/routes/instagram.js";
import googleReviewsRoutes from "./http/routes/google-reviews.js";
import socialPostRoutes from "./http/routes/social-posts.js";
import workspaceRoutes from "./http/routes/workspaces.js";
import formsTokenRoutes from "./http/routes/forms-token.js";
import socialAiRoutes from "./http/routes/social-ai.js";
import collectRoutes from "./http/routes/collect.js";
import trackRoutes from "./http/routes/track.js";
import statsRoutes from "./http/routes/stats.js";
import v1Routes from "./http/routes/v1.js";
import adminRoutes from "./http/routes/admin.js";
import shareRoutes from "./http/routes/share.js";
import seoPublicRoutes from "./http/routes/seo-public.js";
import plansPublicRoutes from "./http/routes/plans-public.js";
import seoRoutes from "./http/routes/seo.js";
import competitorRoutes from "./http/routes/competitors.js";
import competitorBriefRoutes from "./http/routes/competitor-brief.js";
import billingRoutes from "./http/routes/billing.js";
import webhookRoutes from "./http/routes/webhooks.js";
import cronRoutes from "./http/routes/cron.js";
import formsInternalRoutes from "./http/routes/forms-internal.js";
import reportRoutes from "./http/routes/reports.js";
import segmentRoutes from "./http/routes/segments.js";
import brandingRoutes from "./http/routes/branding.js";
import mediaRoutes from "./http/routes/media.js";
import markerRoutes from "./http/routes/markers.js";
import memberRoutes from "./http/routes/members.js";
import inviteRoutes from "./http/routes/invites.js";
import reportsPublicRoutes from "./http/routes/reports-public.js";
import orbitRoutes from "./http/routes/orbit.js";
import orbitPublicRoutes from "./http/routes/orbit-public.js";
import swaggerUi from "swagger-ui-express";
import { buildOpenApiSpec } from "./http/openapi.js";
import { errorHandler, notFoundHandler } from "./http/middleware/index.js";
import { dashboardCors } from "./http/middleware/cors.js";
import { requireUnlocked } from "./http/middleware/auth.js";

const app = express();
// Deployed behind a proxy (Vercel), so the socket address is the proxy's. Trust
// the forwarding headers it sets, otherwise every caller looks like one IP and
// per-address limits would be meaningless.
app.set("trust proxy", true);
// Avatar uploads carry a base64 image in the JSON body, which is far past the
// 100kb default. The larger limit is scoped to that one path rather than applied
// globally — every other endpoint takes small JSON, and a generous body limit on
// all of them is free memory for anyone who wants to spend ours.
app.use("/api/auth/me/avatar", express.json({ limit: "6mb" }));
// Same story for a LinkedIn post: the share card is a 1200x630 PNG drawn in the
// browser and sent as a base64 data URL, since there is no hosted copy of it to
// give LinkedIn instead.
app.use("/api/auth/linkedin/post", express.json({ limit: "12mb" }));
// And for a scheduled post, whose image arrives the same way before being
// uploaded to Cloudinary.
app.use("/api/social/posts", express.json({ limit: "12mb" }));
// A library upload carries whole files in the body — video included — so it
// needs its own ceiling, and it has to be registered before the global parser
// below or the default 100kb limit wins.
app.use("/api/workspaces/:wid/media", express.json({ limit: "40mb" }));
// An Orbit question can carry an attached image as a base64 data URL.
app.use("/api/workspaces/:wid/orbit/ask", express.json({ limit: "8mb" }));
// A form-generation request can carry a photo of the form being recreated.
app.use("/api/internal/forms/generate/:workspaceId", express.json({ limit: "8mb" }));
// Razorpay webhook signatures are over the exact request bytes, so this route
// must see the raw body rather than the parsed-and-reserialised JSON every
// other route gets — it has to be registered before the global json parser.
app.use("/api/webhooks/razorpay", express.raw({ type: "application/json" }));
// Cashfree webhook signatures are over `timestamp + raw body`, so this route
// needs the exact bytes too — registered before the global json parser.
app.use("/api/webhooks/cashfree", express.raw({ type: "application/json" }));
app.use(express.json());
// The tracker sends beacons as text/plain (an application/json beacon would
// trigger a CORS preflight, which sendBeacon cannot perform). Parse those too.
app.use(express.text({ type: ["text/plain", "text/*"] }));

// Open CORS: tracker + collect run on arbitrary customer domains
const openCors = cors({ origin: "*" });

// Open CORS: a status ping carries nothing sensitive, and callers checking
// "is the backend up" (curl, uptime monitors, this repo's own scripts) are
// rarely the dashboard origin.
app.get("/api/health", openCors, (_req: Request, res: Response) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// A human landing on the bare API URL (checking a deploy in a browser) gets a
// page instead of a JSON blob or a 404 — the same status the health check
// reports, just readable.
app.get("/", openCors, (_req: Request, res: Response) => {
  const uptime = process.uptime();
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = Math.floor(uptime % 60);
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Quantalog API</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #0b0e14; color: #e6e6e6;
  }
  .card {
    padding: 2.5rem 3rem; border-radius: 12px; background: #12161f;
    border: 1px solid #232838; text-align: center; min-width: 280px;
  }
  .dot {
    display: inline-block; width: 10px; height: 10px; border-radius: 50%;
    background: #3fd97f; margin-right: 8px; box-shadow: 0 0 8px #3fd97f;
  }
  h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { margin: 0.25rem 0; color: #9aa3b2; font-size: 0.9rem; }
  code { color: #6fb3ff; }
</style>
</head>
<body>
  <div class="card">
    <h1><span class="dot"></span>Quantalog API is running</h1>
    <p>uptime: ${h}h ${m}m ${s}s</p>
    <p>health check: <code>/api/health</code></p>
  </div>
</body>
</html>`);
});

// Public tracking surface (any origin)
app.use("/api/collect", openCors, collectRoutes);
app.use("/api/track", openCors, trackRoutes);

// Serve embeddable tracker.js — gzipped, and cached for as long as this
// build's TRACKER_VERSION is current. A version bump changes the ETag
// (Express derives it from the file's own mtime/size, which the build script
// updates every time it regenerates this file), so a stale cached copy is
// never served past a real change.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
app.get(
  "/tracker.js",
  openCors,
  compression(),
  (_req, res) => {
    res.type("application/javascript");
    res.set("Cache-Control", "public, max-age=86400, must-revalidate");
    res.set("X-Tracker-Version", String(TRACKER_VERSION));
    res.sendFile(path.join(publicDir, "tracker.js"));
  },
);


const openApiSpec = buildOpenApiSpec();
app.get("/openapi.json", openCors, (_req: Request, res: Response) => {
  res.json(openApiSpec);
});
app.use(
  "/docs",
  openCors,
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec, {
    customSiteTitle: "Quantalog API reference",
    // The topbar is Swagger's own branding and a URL box that only lets someone
    // load a different API into our page.
    customCss: ".swagger-ui .topbar { display: none }",

    customJs: [
      "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js",
      "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js",
    ],
    customCssUrl: "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css",
    swaggerOptions: {
      // Endpoints collapsed by default: three tags open at once is a wall of
      // schema before the reader has chosen anything.
      docExpansion: "list",
      // Survives a refresh, so a reader trying several calls authorises once.
      persistAuthorization: true,
      defaultModelsExpandDepth: 0,
      tryItOutEnabled: true,
    },
  }),
);

// Platform API (server-to-server, API-key auth, any origin)
app.use("/v1", openCors, v1Routes);

// Public shared dashboards. Unauthenticated by design — the share token in the
// path is the credential — so it sits outside the dashboard CORS allowlist:
// the whole point is that anyone with the link can open it from anywhere.
app.use("/api/share", openCors, shareRoutes);
// Public per-report SEO audits. Same unauthenticated, token-in-path model as
// the shared dashboards above.
app.use("/api/public/seo", openCors, seoPublicRoutes);
app.use("/api/public/plans", openCors, plansPublicRoutes);
// Report unsubscribe links. Unauthenticated for the same reason as the share
// links above — most recipients have no account, and requiring one to stop
// receiving mail is how a report turns into a spam complaint.
app.use("/api/public/reports", openCors, reportsPublicRoutes);

app.use("/api/public/orbit", openCors, orbitPublicRoutes);

app.use("/api/auth/linkedin", linkedinRoutes);

app.use("/api/auth/instagram", instagramRoutes);
app.use("/auth/instagram", instagramRoutes);

app.use("/api/auth/google-business", googleReviewsRoutes);

// Scheduled social posts. Scoped to the signed-in user rather than a workspace
// prefix: a schedule publishes with that user's own LinkedIn token.
app.use("/api/social/posts", dashboardCors, requireUnlocked, socialPostRoutes);

// Dashboard API (restricted origin + JWT inside route modules). Not
// `requireUnlocked`: this router is where /lock, /unlock and the account's own
// settings live, so it has to stay reachable while the screen is locked — the
// individual data-bearing routes below are the ones the lock actually guards.
app.use("/api/auth", dashboardCors, authRoutes);
// Before the general workspace router: both mount on the same prefix, and the
// composer's two routes are specific paths that a later `/:wid/...` pattern
// could otherwise shadow.
app.use("/api/workspaces", dashboardCors, requireUnlocked, socialAiRoutes);
app.use("/api/workspaces", dashboardCors, requireUnlocked, workspaceRoutes);
// Mints the short-lived token the embedded forms service needs before it will
// hand over or change a workspace's payment credentials. Same prefix, same
// membership check as everything else here.
app.use("/api/workspaces", dashboardCors, requireUnlocked, formsTokenRoutes);
// SEO audits hang off the same prefix; kept in their own router so the
// workspace module stays about workspaces.
app.use("/api/workspaces", dashboardCors, requireUnlocked, seoRoutes);
// Competitor tracking keeps the `/seo/competitors` paths but lives in its own
// router: it is the only place the server fetches a host the user typed, and
// that is worth being able to read in one file.
app.use("/api/workspaces", dashboardCors, requireUnlocked, competitorRoutes);
// The AI reading of a comparison, kept separate: it is the only competitor
// endpoint that costs a model call, carries its own rate limit, and disappears
// entirely when the Cloudflare credentials are unset.
app.use("/api/workspaces", dashboardCors, requireUnlocked, competitorBriefRoutes);
// Scheduled email reports, same prefix and same ownership check.
app.use("/api/workspaces/:wid/reports", dashboardCors, requireUnlocked, reportRoutes);
// Saved dashboard filters and timeline markers, same prefix and ownership rule.
app.use("/api/workspaces/:wid/segments", dashboardCors, requireUnlocked, segmentRoutes);
app.use("/api/workspaces/:wid/branding", dashboardCors, requireUnlocked, brandingRoutes);
app.use("/api/workspaces/:wid/media", dashboardCors, requireUnlocked, mediaRoutes);
app.use("/api/workspaces/:wid/markers", dashboardCors, requireUnlocked, markerRoutes);
// Who else can reach this workspace, and pending invitations to it.
app.use("/api/workspaces/:wid/members", dashboardCors, requireUnlocked, memberRoutes);
// Accepting an invitation. Not under /workspaces: the recipient has no access
// to the workspace yet, which is the whole point of the link.
app.use("/api/invites", dashboardCors, requireUnlocked, inviteRoutes);
app.use("/api/sites", dashboardCors, requireUnlocked, statsRoutes);
// Orbit AI, the in-app assistant. The in-app support form it used to hand over
// to is now a da-forms form embedded on the Help page, which posts to da-forms
// rather than here.
// Mounted under a workspace because Orbit is now metered against one: the AI
// tier, its question quota, and its addon credits all live on the workspace's
// subscription, the same as audits and crawls.
app.use("/api/workspaces/:wid/orbit", dashboardCors, requireUnlocked, orbitRoutes);
app.use("/api/admin", dashboardCors, requireUnlocked, adminRoutes);
app.use("/api/billing", dashboardCors, requireUnlocked, billingRoutes);
// Third-party webhooks: no CORS (never called from a browser) and no JWT —
// the signature check in the route itself is the credential.
app.use("/api/webhooks", webhookRoutes);
// Vercel Cron: same reasoning as the webhooks above — never called from a
// browser, and `CRON_SECRET` in the route is the credential.
app.use("/api/cron", cronRoutes);

app.use("/api/internal/forms", formsInternalRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
