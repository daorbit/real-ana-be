import type { Request } from "express";

const SCRAPER_UA =
  /linkedinbot|facebookexternalhit|facebookcatalog|twitterbot|slackbot|slack-imgproxy|whatsapp|telegrambot|discordbot|embedly|quora link preview|pinterest|redditbot|applebot|skypeuripreview|bingbot|googlebot|vkshare|w3c_validator/i;

export function isScraper(req: Request): boolean {
  return SCRAPER_UA.test(String(req.headers["user-agent"] ?? ""));
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function publicApiOrigin(req: Request): string {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL;
  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol ?? "https").split(",")[0];
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
  return `${proto}://${host}`;
}

export function appOrigin(): string {
  return process.env.PUBLIC_APP_URL || process.env.PUBLIC_SITE_URL || "https://quantalog.daorbit.in";
}

export type PreviewMeta = {
  title: string;
  description: string;
  canonical: string;
  image: string;
  imageAlt: string;
  imageSize?: { width: number; height: number };
  card: "summary" | "summary_large_image";
  redirectTo?: string;
};

export function previewHtml(meta: PreviewMeta): string {
  const e = escapeHtml;
  const size = meta.imageSize
    ? `<meta property="og:image:width" content="${meta.imageSize.width}" />\n<meta property="og:image:height" content="${meta.imageSize.height}" />\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${e(meta.title)}</title>
<meta name="description" content="${e(meta.description)}" />
<link rel="canonical" href="${e(meta.canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Quantalog" />
<meta property="og:url" content="${e(meta.canonical)}" />
<meta property="og:title" content="${e(meta.title)}" />
<meta property="og:description" content="${e(meta.description)}" />
<meta property="og:image" content="${e(meta.image)}" />
<meta property="og:image:secure_url" content="${e(meta.image)}" />
${size}<meta property="og:image:alt" content="${e(meta.imageAlt)}" />
<meta name="twitter:card" content="${meta.card}" />
<meta name="twitter:title" content="${e(meta.title)}" />
<meta name="twitter:description" content="${e(meta.description)}" />
<meta name="twitter:image" content="${e(meta.image)}" />
${meta.redirectTo ? `<meta http-equiv="refresh" content="0; url=${e(meta.redirectTo)}" />` : ""}
</head>
<body>
<p><a href="${e(meta.redirectTo ?? meta.canonical)}">${e(meta.title)}</a></p>
</body>
</html>`;
}
