import "express-async-errors";
import express, { Request, Response } from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import path from "path";
import { fileURLToPath } from "url";
import { TRACKER_VERSION } from "./modules/analytics/stats.service.js";
import authRoutes from "./http/routes/auth.js";
import linkedinRoutes from "./http/routes/linkedin.js";
import githubRoutes from "./http/routes/github.js";
import googleLoginRoutes from "./http/routes/google-login.js";
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
import adminReferralRoutes from "./http/routes/admin-referrals.js";
import referralRoutes from "./http/routes/referrals.js";
import shareRoutes from "./http/routes/share.js";
import seoPublicRoutes from "./http/routes/seo-public.js";
import plansPublicRoutes from "./http/routes/plans-public.js";
import seoRoutes from "./http/routes/seo.js";
import searchConsoleRoutes from "./http/routes/search-console.js";
import searchConsoleAuthRoutes from "./http/routes/search-console-auth.js";
import competitorRoutes from "./http/routes/competitors.js";
import competitorBriefRoutes from "./http/routes/competitor-brief.js";
import backlinkRoutes from "./http/routes/backlinks.js";
import billingRoutes from "./http/routes/billing.js";
import webhookRoutes from "./http/routes/webhooks.js";
import cronRoutes from "./http/routes/cron.js";
import formsInternalRoutes from "./http/routes/forms-internal.js";
import reportRoutes from "./http/routes/reports.js";
import segmentRoutes from "./http/routes/segments.js";
import brandingRoutes from "./http/routes/branding.js";
import navPrefsRoutes from "./http/routes/nav-prefs.js";
import mediaRoutes from "./http/routes/media.js";
import markerRoutes from "./http/routes/markers.js";
import memberRoutes from "./http/routes/members.js";
import auditRoutes from "./http/routes/audit.js";
import inviteRoutes from "./http/routes/invites.js";
import reportsPublicRoutes from "./http/routes/reports-public.js";
import notificationRoutes from "./http/routes/notifications.js";
import noteRoutes from "./http/routes/notes.js";
import orbitRoutes from "./http/routes/orbit.js";
import orbitPublicRoutes from "./http/routes/orbit-public.js";
import dashboardRoutes from "./http/routes/dashboards.js";
import goalTargetRoutes from "./http/routes/goal-targets.js";
import embedRoutes from "./http/routes/embeds.js";
import embedPublicRoutes from "./http/routes/embed-public.js";
import swaggerUi from "swagger-ui-express";
import { buildOpenApiSpec } from "./http/openapi.js";
import { renderStatusPage } from "./http/views/status-page.js";
import { errorHandler, notFoundHandler } from "./http/middleware/index.js";
import { dashboardCors, orbitCors } from "./http/middleware/cors.js";
import { requireUnlocked } from "./http/middleware/auth.js";
import { requireApiKeyOrAuth } from "./http/middleware/orbit-access.js";
import { auditTrail } from "./http/middleware/audit-trail.js";

const app = express();

app.set("trust proxy", true);
app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

app.use(["/api", "/v1"], compression());

app.use("/api/auth/me/avatar", express.json({ limit: "6mb" }));
app.use("/api/workspaces/:wid/nav/links", express.json({ limit: "2mb" }));

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

app.use(express.text({ type: ["text/plain", "text/*"] }));

// Open CORS: tracker + collect run on arbitrary customer domains
const openCors = cors({ origin: "*" });


app.get("/api/health", openCors, (_req: Request, res: Response) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/", openCors, (_req: Request, res: Response) => {
  res.type("html").send(renderStatusPage(process.uptime()));
});

// Public tracking surface (any origin)
app.use(["/api/collect", "/api/ingest"], openCors, collectRoutes);
app.use("/api/track", openCors, trackRoutes);


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
app.get(
  "/tracker.js",
  openCors,
  compression(),
  (_req, res) => {
    res.type("application/javascript");
    res.set("Cache-Control", "public, no-cache");
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

app.use("/v1", openCors, v1Routes);


app.use("/api/share", openCors, shareRoutes);
// Public per-report SEO audits. Same unauthenticated, token-in-path model as
// the shared dashboards above.
app.use("/api/public/seo", openCors, seoPublicRoutes);
app.use("/api/public/plans", openCors, plansPublicRoutes);

app.use("/api/public/reports", openCors, reportsPublicRoutes);

app.use("/api/public/orbit", openCors, orbitPublicRoutes);
app.use("/api/embed", openCors, embedPublicRoutes);

app.use("/api/auth/linkedin", linkedinRoutes);

app.use("/api/auth/github", githubRoutes);
app.use("/auth/github", githubRoutes);

app.use("/api/auth/google-oauth", dashboardCors, googleLoginRoutes);

app.use("/api/auth/instagram", instagramRoutes);
app.use("/auth/instagram", instagramRoutes);

app.use("/api/auth/google-business", googleReviewsRoutes);

app.use("/api/auth/search-console", searchConsoleAuthRoutes);

// Scheduled social posts. Scoped to the signed-in user rather than a workspace
// prefix: a schedule publishes with that user's own LinkedIn token.
app.use("/api/social/posts", dashboardCors, requireUnlocked, socialPostRoutes);

app.use("/api/auth", dashboardCors, authRoutes);

app.use("/api/workspaces/:wid", auditTrail);
app.use("/api/workspaces/:wid/orbit", orbitCors, requireApiKeyOrAuth, requireUnlocked, orbitRoutes);

app.use("/api/workspaces", dashboardCors, requireUnlocked, socialAiRoutes);
app.use("/api/workspaces", dashboardCors, requireUnlocked, workspaceRoutes);

app.use("/api/workspaces", dashboardCors, requireUnlocked, formsTokenRoutes);

app.use("/api/workspaces", dashboardCors, requireUnlocked, seoRoutes);
app.use("/api/workspaces", dashboardCors, requireUnlocked, searchConsoleRoutes);

app.use("/api/workspaces", dashboardCors, requireUnlocked, competitorRoutes);
// The AI reading of a comparison, kept separate: it is the only competitor
// endpoint that costs a model call, carries its own rate limit, and disappears
// entirely when the Cloudflare credentials are unset.
app.use("/api/workspaces", dashboardCors, requireUnlocked, competitorBriefRoutes);
app.use("/api/workspaces", dashboardCors, requireUnlocked, backlinkRoutes);
// Scheduled email reports, same prefix and same ownership check.
app.use("/api/workspaces/:wid/reports", dashboardCors, requireUnlocked, reportRoutes);
// Saved dashboard filters and timeline markers, same prefix and ownership rule.
app.use("/api/workspaces/:wid/segments", dashboardCors, requireUnlocked, segmentRoutes);
app.use("/api/workspaces/:wid/branding", dashboardCors, requireUnlocked, brandingRoutes);
app.use("/api/workspaces/:wid/nav", dashboardCors, requireUnlocked, navPrefsRoutes);
app.use("/api/workspaces/:wid/media", dashboardCors, requireUnlocked, mediaRoutes);
app.use("/api/workspaces/:wid/markers", dashboardCors, requireUnlocked, markerRoutes);
app.use("/api/workspaces/:wid/dashboards", dashboardCors, requireUnlocked, dashboardRoutes);
app.use("/api/workspaces/:wid/targets", dashboardCors, requireUnlocked, goalTargetRoutes);
app.use("/api/workspaces/:wid/embeds", dashboardCors, requireUnlocked, embedRoutes);
// Who else can reach this workspace, and pending invitations to it.
app.use("/api/workspaces/:wid/members", dashboardCors, requireUnlocked, memberRoutes);
app.use("/api/workspaces/:wid/audit", dashboardCors, requireUnlocked, auditRoutes);
// Accepting an invitation. Not under /workspaces: the recipient has no access
// to the workspace yet, which is the whole point of the link.
app.use("/api/invites", dashboardCors, requireUnlocked, inviteRoutes);

app.use("/api/notifications", dashboardCors, requireUnlocked, notificationRoutes);
app.use("/api/notes", dashboardCors, requireUnlocked, noteRoutes);
app.use("/api/sites", dashboardCors, requireUnlocked, statsRoutes);
app.use("/api/admin/referrals", dashboardCors, requireUnlocked, adminReferralRoutes);
app.use("/api/admin", dashboardCors, requireUnlocked, adminRoutes);
app.use("/api/billing", dashboardCors, requireUnlocked, billingRoutes);
app.use("/api/referrals", dashboardCors, requireUnlocked, referralRoutes);

app.use("/api/webhooks", webhookRoutes);

app.use("/api/cron", cronRoutes);

app.use("/api/internal/forms", formsInternalRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
