import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import authRoutes from "./http/routes/auth.js";
import workspaceRoutes from "./http/routes/workspaces.js";
import collectRoutes from "./http/routes/collect.js";
import statsRoutes from "./http/routes/stats.js";
import v1Routes from "./http/routes/v1.js";
import adminRoutes from "./http/routes/admin.js";
import shareRoutes from "./http/routes/share.js";
import seoPublicRoutes from "./http/routes/seo-public.js";
import plansPublicRoutes from "./http/routes/plans-public.js";
import seoRoutes from "./http/routes/seo.js";
import competitorRoutes from "./http/routes/competitors.js";
import billingRoutes from "./http/routes/billing.js";
import webhookRoutes from "./http/routes/webhooks.js";
import cronRoutes from "./http/routes/cron.js";
import reportRoutes from "./http/routes/reports.js";
import segmentRoutes from "./http/routes/segments.js";
import markerRoutes from "./http/routes/markers.js";
import memberRoutes from "./http/routes/members.js";
import inviteRoutes from "./http/routes/invites.js";
import reportsPublicRoutes from "./http/routes/reports-public.js";
import contactPublicRoutes from "./http/routes/contact-public.js";
import newsletterPublicRoutes from "./http/routes/newsletter-public.js";
import supportRoutes from "./http/routes/support.js";
import orbitRoutes from "./http/routes/orbit.js";
import formRoutes from "./http/routes/forms.js";
import formsPublicRoutes from "./http/routes/forms-public.js";
import { errorHandler, notFoundHandler } from "./http/middleware/index.js";

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
// Razorpay webhook signatures are over the exact request bytes, so this route
// must see the raw body rather than the parsed-and-reserialised JSON every
// other route gets — it has to be registered before the global json parser.
app.use("/api/webhooks/razorpay", express.raw({ type: "application/json" }));
app.use(express.json());
// The tracker sends beacons as text/plain (an application/json beacon would
// trigger a CORS preflight, which sendBeacon cannot perform). Parse those too.
app.use(express.text({ type: ["text/plain", "text/*"] }));

const dashboardOrigins = [
  "http://localhost:5173",
  "https://real-ana-fe.vercel.app",
  "https://studio-quantalog.daorbit.in",
];

// Dashboard CORS: restricted to our own frontend
const dashboardCors = cors({
  origin: (origin, cb) => {
    if (!origin || dashboardOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`Origin not allowed: ${origin}`));
  },
});

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

// Serve embeddable tracker.js
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
app.get("/tracker.js", openCors, (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(publicDir, "tracker.js"));
});

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
// The marketing site's contact form. Open CORS because the landing page is a
// different origin from the dashboard and is deliberately not in that
// allowlist; the route only writes, and reading messages back is admin-only.
app.use("/api/public/contact", openCors, contactPublicRoutes);
// The newsletter dialog on the same site. Same origin story, same write-only shape.
app.use("/api/public/newsletter", openCors, newsletterPublicRoutes);
// The hosted form page, iframed on arbitrary customer domains — same open,
// unauthenticated model as `/api/collect`.
app.use("/api/public/forms", openCors, formsPublicRoutes);

// Dashboard API (restricted origin + JWT inside route modules)
app.use("/api/auth", dashboardCors, authRoutes);
app.use("/api/workspaces", dashboardCors, workspaceRoutes);
// SEO audits hang off the same prefix; kept in their own router so the
// workspace module stays about workspaces.
app.use("/api/workspaces", dashboardCors, seoRoutes);
// Competitor tracking keeps the `/seo/competitors` paths but lives in its own
// router: it is the only place the server fetches a host the user typed, and
// that is worth being able to read in one file.
app.use("/api/workspaces", dashboardCors, competitorRoutes);
// Scheduled email reports, same prefix and same ownership check.
app.use("/api/workspaces/:wid/reports", dashboardCors, reportRoutes);
// Saved dashboard filters and timeline markers, same prefix and ownership rule.
app.use("/api/workspaces/:wid/segments", dashboardCors, segmentRoutes);
app.use("/api/workspaces/:wid/markers", dashboardCors, markerRoutes);
// Who else can reach this workspace, and pending invitations to it.
app.use("/api/workspaces/:wid/members", dashboardCors, memberRoutes);
// Accepting an invitation. Not under /workspaces: the recipient has no access
// to the workspace yet, which is the whole point of the link.
app.use("/api/invites", dashboardCors, inviteRoutes);
app.use("/api/sites", dashboardCors, statsRoutes);
app.use("/api/support", dashboardCors, supportRoutes);
// Orbit AI, the in-app assistant. Beside support rather than under it: the two
// are the same job — a stuck user — and Orbit hands over to the form when it
// cannot help.
// Mounted under a workspace because Orbit is now metered against one: the AI
// tier, its question quota, and its addon credits all live on the workspace's
// subscription, the same as audits and crawls.
app.use("/api/workspaces/:wid/orbit", dashboardCors, orbitRoutes);
// Lead forms: create/list under the workspace prefix, everything naming one
// form directly (detail/update/publish/submissions) under its own id-based
// prefix — see the routing note at the top of `forms.ts`.
app.use("/api/workspaces/:wid/forms", dashboardCors, formRoutes);
app.use("/api/forms", dashboardCors, formRoutes);
app.use("/api/admin", dashboardCors, adminRoutes);
app.use("/api/billing", dashboardCors, billingRoutes);
// Third-party webhooks: no CORS (never called from a browser) and no JWT —
// the signature check in the route itself is the credential.
app.use("/api/webhooks", webhookRoutes);
// Vercel Cron: same reasoning as the webhooks above — never called from a
// browser, and `CRON_SECRET` in the route is the credential.
app.use("/api/cron", cronRoutes);

// Both must stay last: the 404 only fires once every router has declined the
// path, and the error handler only receives what the routers above pass to
// `next`. Anything mounted after them would be unreachable.
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
