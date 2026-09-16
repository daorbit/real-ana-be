import {
  actionButton,
  bannerShell,
  bulletList,
  escapeHtml,
  line,
  signOff,
  type BannerName,
} from "./shared.js";

const BANNER: BannerName = "seo-audit";

const CHECKS = [
  "Meta tags and canonical URLs",
  "Core Web Vitals from real visitors",
  "Broken links and redirect chains",
  "Structured data and sitemap health",
];

export function seoAuditHtml(intro: string, cta: { label: string; href: string }): string {
  return bannerShell(
    BANNER,
    `${paragraphs(intro)}
     ${bulletList("What an audit checks", CHECKS, BANNER)}
     ${actionButton(cta.label, cta.href, BANNER)}
     ${signOff()}`,
  );
}

function paragraphs(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((block, i) => line(block.replace(/\n/g, "<br>"), i === 0 ? 0 : 10))
    .join("");
}
