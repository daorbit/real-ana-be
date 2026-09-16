import {
  actionButton,
  bannerShell,
  escapeHtml,
  signOff,
  stepList,
  line,
  type BannerName,
} from "./shared.js";

const BANNER: BannerName = "welcome";

const STEPS = [
  { title: "Add your site", body: "Name and domain. Takes about ten seconds." },
  { title: "Copy the snippet", body: "One script tag, generated for that site." },
  { title: "Watch it arrive", body: "Traffic shows up live, with no sampling and no cookie banner." },
];

export function welcomeHtml(intro: string, cta: { label: string; href: string }): string {
  return bannerShell(
    BANNER,
    `${paragraphs(intro)}
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
