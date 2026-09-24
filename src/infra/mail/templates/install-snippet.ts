import {
  actionButton,
  bannerShell,
  codeSnippet,
  escapeHtml,
  line,
  signOff,
  stepList,
  type BannerName,
} from "./shared.js";

const BANNER: BannerName = "install-snippet";

const TRACKER_ORIGIN = (process.env.PUBLIC_BASE_URL || "https://quantalog-be.daorbit.in").replace(/\/+$/, "");
const SNIPPET = `<script async src="${TRACKER_ORIGIN}/tracker.js" data-site="YOUR-SITE-ID"></script>`;

const STEPS = [
  { title: "Paste it before &lt;/head&gt;", body: "Anywhere in the head works. One line, on every page you want counted." },
  { title: "Load any page", body: "The first pageview lands within a few seconds — no waiting for a nightly job." },
];

export function installSnippetHtml(intro: string, cta: { label: string; href: string }): string {
  return bannerShell(
    BANNER,
    `${paragraphs(intro)}
     ${codeSnippet(SNIPPET, BANNER)}
     ${stepList(STEPS, BANNER)}
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
