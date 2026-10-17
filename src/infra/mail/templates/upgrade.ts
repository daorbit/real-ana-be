import { actionButton, bannerShell, bulletList, escapeHtml, line, signOff, type BannerName } from "./shared.js";

const BANNER: BannerName = "upgrade";

const PRO_ADDS = [
  "Daily reports, plus alerts on WhatsApp",
  "Year-over-year comparison on every chart",
  "16 months of Google Search data with full insights",
  "50 SEO audits and 50 site crawls every month",
  "2 million tracked events a month",
  "Priority support",
];

function paragraphs(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((block, i) => line(block.replace(/\n/g, "<br>"), i === 0 ? 0 : 10))
    .join("");
}

export function upgradeHtml(text: string, cta: { label: string; href: string }): string {
  return bannerShell(
    BANNER,
    `${paragraphs(text)}
     ${bulletList("What Pro adds", PRO_ADDS, BANNER)}
     ${actionButton(cta.label, cta.href, BANNER)}
     ${signOff()}`,
  );
}
