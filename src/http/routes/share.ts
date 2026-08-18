import { Router, Request, Response } from "express";
import { Workspace } from "../../modules/workspace/models/Workspace.js";
import { Site } from "../../modules/analytics/models/Site.js";
import { computeStats, resolveWindow } from "../../modules/analytics/stats.service.js";
import { renderShareCardPng } from "../../modules/analytics/share-card.js";

/**
 * Public, unauthenticated read-only dashboards.
 *
 * The share token is the entire credential, so this router is deliberately
 * narrow: one route, no parameters beyond a range, and a response that is
 * built field by field rather than spread from the stats object. Anything not
 * listed here cannot leak, even if `computeStats` grows new fields later.
 *
 * Never exposed: site ids (they are the public tracking keys — leaking one
 * lets anyone post events into the customer's analytics), workspace id, owner
 * identity, raw events, or per-site breakdowns.
 */
const router = Router();

/** Ranges a public viewer may request. Anything else falls back to 30 days. */
const PUBLIC_RANGES = new Set(["24h", "7d", "30d"]);

/** Where the dashboard itself lives, for canonical links and redirects. */
function appOrigin(): string {
  return process.env.PUBLIC_APP_URL || process.env.PUBLIC_SITE_URL || "https://quantalog.daorbit.in";
}

/**
 * Look up a live share token and its headline figures.
 *
 * Shared by the card image and the preview page, both of which need exactly the
 * published numbers and nothing else. Returns `null` for an unknown or disabled
 * token, which every caller turns into a 404.
 */
async function loadShared(token: string) {
  if (!token.startsWith("pk_") || token.length > 64) return null;

  const ws = await Workspace.findOne({ shareToken: token, shareEnabled: true })
    .select("name sharePanels");
  if (!ws) return null;

  const raw = (ws.get("sharePanels") ?? {}) as Record<string, unknown>;
  const totals = raw.totals === undefined ? true : Boolean(raw.totals);

  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const siteIds = sites.map((s) => s.siteId as string);

  // Figures are only read when the owner published them. A card cannot quote a
  // number the dashboard itself withholds.
  const stats =
    totals && siteIds.length
      ? await computeStats(siteIds, "30d", {}, resolveWindow("30d"))
      : null;

  return {
    name: ws.get("name") as string,
    totals,
    visitors: stats?.visitors ?? 0,
    pageviews: stats?.pageviews ?? 0,
    live: stats && stats.live > 0 ? stats.live : null,
  };
}

/**
 * The preview card as a PNG.
 *
 * Referenced by `og:image` on the page below, so the fetcher is a social
 * network's scraper rather than a browser. Cached hard: the numbers move, but a
 * preview image regenerated on every scrape would have us rendering a card each
 * time a post is viewed in a feed.
 */
router.get("/:token/card.png", async (req: Request, res: Response) => {
  const shared = await loadShared(String(req.params.token ?? ""));
  if (!shared) return res.status(404).json({ error: "not found" });

  try {
    const png = await renderShareCardPng({
      workspace: shared.name,
      url: `${appOrigin()}/share/${req.params.token}`,
      rangeLabel: "Last 30 days",
      visitors: shared.visitors,
      pageviews: shared.pageviews,
      live: shared.live,
    });

    res.type("png");
    res.set("Cache-Control", "public, max-age=3600, s-maxage=3600");
    res.send(png);
  } catch (e) {
    console.error("[share] card render failed:", (e as Error).message);
    res.status(500).json({ error: "could not render card" });
  }
});

/**
 * Social and chat-app link scrapers, by user agent.
 *
 * LinkedIn is the strict one and the reason this list exists: its crawler
 * reads the raw HTML and treats a zero-delay `<meta http-equiv="refresh">` as
 * a redirect to follow, landing it on the single-page app — whose generic tags
 * are exactly what this route exists to avoid serving. Facebook, X, Slack and
 * WhatsApp are matched too so all of them read one consistent head.
 *
 * Matched loosely on purpose: a crawler that renames itself and falls through
 * to the human path still gets a page whose head is correct, just with the
 * refresh tag attached.
 */
const SCRAPER_UA =
  /linkedinbot|facebookexternalhit|facebookcatalog|twitterbot|slackbot|slack-imgproxy|whatsapp|telegrambot|discordbot|embedly|quora link preview|pinterest|redditbot|applebot|skypeuripreview|bingbot|googlebot|vkshare|w3c_validator/i;

function isScraper(req: Request): boolean {
  return SCRAPER_UA.test(String(req.headers["user-agent"] ?? ""));
}

/**
 * The link-preview page for a shared dashboard.
 *
 * Social scrapers do not run JavaScript, so the single-page app serves them the
 * site's generic tags no matter which dashboard was linked — which is why a
 * shared link previewed as the marketing page rather than the workspace. This
 * route answers that fetch with tags built for the specific token, and sends
 * anyone with a browser on to the dashboard itself.
 *
 * Crawler and browser get different pages, because what each needs breaks the
 * other:
 *
 * - A browser needs to be moved on to the dashboard, which the meta refresh
 *   does. Served to LinkedIn, that same tag reads as a redirect: it abandons
 *   this head, follows to the app, finds the generic tags there, and the post
 *   previews as the marketing page with no card — the bug this route was
 *   written to fix, reintroduced by the tag that serves the browser.
 * - A crawler needs `og:url` and the canonical to point back *here*, because a
 *   scraper treats them as the address to attribute (and often to re-scrape).
 *   Pointing them at the app sent LinkedIn to the tagless SPA by a second
 *   route. Humans still land on the dashboard: only the tags differ, and the
 *   crawler never renders them.
 */
router.get("/:token/preview", async (req: Request, res: Response) => {
  const token = String(req.params.token ?? "");
  const shared = await loadShared(token);
  const target = `${appOrigin()}/share/${token}`;

  // An unknown token gets the generic page rather than an error: a 404 in a
  // feed renders as a broken card, and the link itself already 404s honestly
  // when someone opens it.
  if (!shared) return res.redirect(302, target);

  const bot = isScraper(req);
  const self = `${publicApiOrigin(req)}/api/share/${token}/preview`;
  const cardUrl = `${publicApiOrigin(req)}/api/share/${token}/card.png`;
  // A scraper attributes the post to whatever `og:url` names, so it has to be
  // this page. A browser is leaving anyway, and the dashboard is the address
  // worth recording.
  const canonical = bot ? self : target;

  const title = `${shared.name} — live analytics`;
  const description = shared.totals
    ? `${shared.visitors.toLocaleString()} visitors and ${shared.pageviews.toLocaleString()} pageviews in the last 30 days. A public, read-only dashboard on Quantalog.`
    : `A public, read-only analytics dashboard for ${shared.name}, on Quantalog.`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${escapeHtml(canonical)}" />

<meta property="og:type" content="website" />
<meta property="og:site_name" content="Quantalog" />
<meta property="og:url" content="${escapeHtml(canonical)}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:image" content="${escapeHtml(cardUrl)}" />
<meta property="og:image:secure_url" content="${escapeHtml(cardUrl)}" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="${escapeHtml(`Analytics summary for ${shared.name}`)}" />

<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(cardUrl)}" />
${bot ? "" : `<meta http-equiv="refresh" content="0; url=${escapeHtml(target)}" />`}
</head>
<body>
<p>Redirecting to <a href="${escapeHtml(target)}">${escapeHtml(title)}</a>…</p>
</body>
</html>`;

  res.type("html");
  // Short cache: the description carries figures, and a scraper re-reading a
  // day-old card should not quote last week's numbers.
  //
  // `Vary: User-Agent` because the two audiences get different HTML — without
  // it a CDN can hand a crawler the browser's copy (refresh tag and all),
  // which is the exact failure this split was written to prevent.
  res.set("Vary", "User-Agent");
  res.set("Cache-Control", "public, max-age=600, s-maxage=600");
  res.send(html);
});

/** Escape text bound for an HTML attribute or text node. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * This API's own public origin, for building the `og:image` URL.
 *
 * Read from the request rather than configuration so the tags are correct
 * behind whichever host actually served them, with the proxy headers honoured
 * because the scraper's fetch arrives through one.
 */
function publicApiOrigin(req: Request): string {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL;
  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol ?? "https").split(",")[0];
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
  return `${proto}://${host}`;
}

router.get("/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token ?? "");
  // Cheap shape check before touching the database, so a flood of junk tokens
  // costs nothing to reject.
  if (!token.startsWith("pk_") || token.length > 64) {
    return res.status(404).json({ error: "not found" });
  }

  const ws = await Workspace.findOne({ shareToken: token, shareEnabled: true })
    .select("name createdAt sharePanels");
  // A disabled or unknown token gets the same 404 — distinguishing them would
  // confirm that a token exists, which is information a guesser can use.
  if (!ws) return res.status(404).json({ error: "not found" });

  // Count the open. Fire-and-forget: a failed counter must never stop the
  // dashboard rendering, and the owner cares about the trend, not exactness.
  // Only the first page load counts — range switches re-fetch, and counting
  // those would turn one visitor idly clicking tabs into four "views".
  if (req.query.count === "1") {
    Workspace.updateOne(
      { _id: ws.id },
      { $inc: { shareViews: 1 }, $set: { shareLastViewedAt: new Date() } },
    ).catch(() => {});
  }

  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const siteIds = sites.map((s) => s.siteId as string);

  const rangeKey = PUBLIC_RANGES.has(String(req.query.range))
    ? String(req.query.range)
    : "30d";

  // Panels the owner turned off are omitted from the response entirely rather
  // than hidden by the client — data that never leaves the server cannot be
  // read out of the network tab.
  const raw = (ws.get("sharePanels") ?? {}) as Record<string, unknown>;
  // Panels added after launch default to off, so an existing shared link never
  // starts publishing a new breakdown just because we deployed. Only the
  // original six fall back to on.
  const on = (key: string, fallback: boolean) =>
    raw[key] === undefined ? fallback : Boolean(raw[key]);

  const panels = {
    totals: on("totals", true),
    trend: on("trend", true),
    pages: on("pages", true),
    sources: on("sources", true),
    countries: on("countries", true),
    devices: on("devices", true),

    browsers: on("browsers", false),
    operatingSystems: on("operatingSystems", false),
    entryPages: on("entryPages", false),
    exitPages: on("exitPages", false),
    languages: on("languages", false),
    channels: on("channels", false),
    engagement: on("engagement", false),
    visitorSplit: on("visitorSplit", false),
  };

  if (siteIds.length === 0) {
    return res.json({
      workspace: ws.get("name"),
      range: rangeKey,
      panels,
      pageviews: 0,
      visitors: 0,
      live: 0,
      topPages: [],
      topReferrers: [],
      countries: [],
      devices: [],
      browsers: [],
      operatingSystems: [],
      entryPages: [],
      exitPages: [],
      languages: [],
      channels: [],
      visitorSplit: null,
      bounceRate: 0,
      avgSessionMs: 0,
      pagesPerSession: 0,
      timeseries: [],
    });
  }

  const win = resolveWindow(rangeKey);
  const stats = await computeStats(siteIds, rangeKey, {}, win);

  // Explicit allowlist — not a spread. Adding a field to the dashboard's stats
  // must never silently publish it here.
  res.json({
    workspace: ws.get("name"),
    range: rangeKey,
    panels,
    pageviews: panels.totals ? stats.pageviews : 0,
    visitors: panels.totals ? stats.visitors : 0,
    live: panels.totals ? stats.live : 0,
    topPages: panels.pages ? stats.topPages : [],
    topReferrers: panels.sources ? stats.topReferrers : [],
    countries: panels.countries ? stats.countries : [],
    devices: panels.devices ? stats.devices : [],
    browsers: panels.browsers ? stats.browsers : [],
    operatingSystems: panels.operatingSystems ? stats.operatingSystems : [],
    entryPages: panels.entryPages ? stats.entryPages : [],
    exitPages: panels.exitPages ? stats.exitPages : [],
    languages: panels.languages ? stats.languages : [],
    channels: panels.channels ? stats.channels : [],
    visitorSplit: panels.visitorSplit ? stats.visitorSplit : null,

    // Engagement travels as one panel — three numbers that only make sense
    // read together, and splitting them into three toggles is noise.
    bounceRate: panels.engagement ? stats.bounceRate : 0,
    avgSessionMs: panels.engagement ? stats.avgSessionMs : 0,
    pagesPerSession: panels.engagement ? stats.pagesPerSession : 0,

    timeseries: panels.trend ? stats.timeseries : [],
  });
});

export default router;
