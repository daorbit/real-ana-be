import {
  LINKS,
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

export function signupWelcomeIntro(name?: string): string {
  const who = name?.trim() ? ` ${name.trim().split(" ")[0]}` : "";
  return `Hello${who},

Thanks for signing up. You're three short steps from live traffic, and none of them involve a cookie banner.

If anything's unclear, just reply to this email. We read every message.`;
}

export function signupWelcomeCta(): { label: string; href: string } {
  return { label: "Add my first site", href: `${LINKS.app}/app/onboarding` };
}

export function welcomeText(name?: string): string {
  return `${signupWelcomeIntro(name)}

1. Add your site — name and domain. Takes about ten seconds.
2. Copy the snippet — one script tag, generated for that site.
3. Watch it arrive — traffic shows up live, with no sampling and no cookie banner.

Add your first site: ${signupWelcomeCta().href}

The Quantalog Team`;
}

function paragraphs(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((block, i) => line(block.replace(/\n/g, "<br>"), i === 0 ? 0 : 10))
    .join("");
}
