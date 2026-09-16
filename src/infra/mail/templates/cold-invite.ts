import {
  C,
  LINKS,
  THEMES,
  actionButton,
  bannerShell,
  escapeAttr,
  escapeHtml,
  line,
  signOff,
  small,
  type BannerName,
} from "./shared.js";

const BANNER: BannerName = "cold-invite";

const FEATURES: { title: string; body: string }[] = [
  { title: "Live in 3 seconds", body: "Visitors and pageviews stream in as they happen. No batch, no sampling." },
  { title: "No cookie banner", body: "Visitors are a rotating daily hash, so no consent prompt is required." },
  { title: "One script tag", body: "Sub-kilobyte tracker, with an API behind every number in the dashboard." },
];

export function coldInviteHtml(intro: string, cta: { label: string; href: string }): string {
  return bannerShell(
    BANNER,
    `${paragraphs(intro)}
     ${featureTable()}
     ${small(`Free to start — or try the <a href="${escapeAttr(LINKS.site)}" style="color:${THEMES[BANNER].accentDeep};text-decoration:none;font-weight:600">live demo</a>, which needs no account.`, 16)}
     ${actionButton(cta.label, cta.href, BANNER)}
     ${signOff()}`,
  );
}

export function coldInviteText(intro: string, cta: { label: string; href: string }): string {
  return `${intro}

${FEATURES.map((f) => `${f.title} — ${f.body}`).join("\n")}

Free to start, or try the live demo (no account needed): ${LINKS.site}

${cta.label}: ${cta.href}

The Quantalog Team`;
}

function featureTable(): string {
  const theme = THEMES[BANNER];

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0 0">
    ${FEATURES.map(
      (f) => `<tr>
      <td width="16" style="padding:0 0 12px;vertical-align:top">
        <div style="width:6px;height:6px;border-radius:50%;background:${theme.accent};margin-top:7px"></div>
      </td>
      <td style="padding:0 0 12px;vertical-align:top">
        <span style="font-size:14px;font-weight:600;color:${C.text}">${escapeHtml(f.title)}</span>
        <span style="font-size:14px;color:${C.faint}"> — ${escapeHtml(f.body)}</span>
      </td>
    </tr>`,
    ).join("")}
  </table>`;
}

function paragraphs(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((block, i) => line(block.replace(/\n/g, "<br>"), i === 0 ? 0 : 10))
    .join("");
}
