import { appOrigin, previewHtml } from "../../shared/utils/link-preview.js";
import type { PublicBioPage } from "./bio-present.js";

function describe(page: PublicBioPage): string {
  if (page.kind === "release" && page.release) {
    const services = page.release.rows.slice(0, 4).map((r) => r.name);
    const more = page.release.rows.length > 4 ? " and more" : "";
    return services.length ? `Listen and watch on ${services.join(", ")}${more}.` : page.release.subtitle || page.title;
  }
  return page.bio.replace(/\s+/g, " ").trim() || `Links from ${page.title}.`;
}

export function bioPageUrl(slug: string): string {
  return `${appOrigin()}/l/${slug}`;
}

export function bioPreviewHtml(page: PublicBioPage): string {
  const image = (page.kind === "release" ? page.release?.artworkUrl : page.avatarUrl) || `${appOrigin()}/OgImage.png`;
  return previewHtml({
    title: page.title,
    description: describe(page).slice(0, 200),
    canonical: bioPageUrl(page.slug),
    image,
    imageAlt: page.title,
    card: page.kind === "release" ? "summary_large_image" : "summary",
  });
}
