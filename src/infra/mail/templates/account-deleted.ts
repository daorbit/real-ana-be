import {
  LINKS,
  bannerShell,
  greetingLine,
  line,
  signOff,
  warningPanel,
  type BannerName,
} from "./shared.js";

const BANNER: BannerName = "password-change";

function workspacesSentence(count: number): string {
  if (count === 0) return "You did not own any workspaces, so no workspace data was affected.";
  return count === 1
    ? "The workspace you owned was deleted with it, including its sites, analytics, forms, submissions and media."
    : `The ${count} workspaces you owned were deleted with it, including their sites, analytics, forms, submissions and media.`;
}

export function accountDeletedHtml(workspaces: number, name?: string): string {
  return bannerShell(
    BANNER,
    `${greetingLine(name)}
     ${line("Your Quantalog account has been permanently deleted, as you asked.")}
     ${line(workspacesSentence(workspaces))}
     ${line("Billing records are kept only as long as tax law requires. Everything else is gone, and this cannot be undone.")}
     ${warningPanel(
       `<strong style="color:#111827">If you didn't do this</strong>, someone else had access to your account. Reply to this email straight away so we can help.`,
     )}
     ${line(`You are always welcome back at <a href="${LINKS.site}" style="color:inherit">${LINKS.site.replace(/^https?:\/\//, "")}</a>.`, 18)}
     ${signOff()}`,
  );
}

export function accountDeletedText(workspaces: number, name?: string): string {
  return `Hello${name?.trim() ? ` ${name.trim()}` : ""},

Your Quantalog account has been permanently deleted, as you asked.

${workspacesSentence(workspaces)}

Billing records are kept only as long as tax law requires. Everything else is gone, and this cannot be undone.

If you didn't do this, someone else had access to your account. Reply to this email straight away so we can help.

You are always welcome back at ${LINKS.site}.

The Quantalog Team`;
}
