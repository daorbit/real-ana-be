import {
  actionButton,
  bannerShell,
  greetingLine,
  infoPanel,
  line,
  signOff,
  small,
  type BannerName,
} from "./shared.js";

const BANNER: BannerName = "invite";

export type InviteInfo = {
  workspaceName: string;
  inviterName: string;
  role: string;
  expiresInDays: number;
  hasAccount: boolean;
};

export function roleLine(role: string): string {
  if (role === "viewer") return "View-only access: you can see everything, and nothing you do can change it.";
  if (role === "editor") return "You'll be able to add sites, run audits, and manage reports.";
  return "You'll be able to manage the workspace, including inviting other people.";
}

export function nextStepLine(hasAccount: boolean): string {
  return hasAccount
    ? "Sign in to accept it."
    : "You'll be asked to create an account first — use this address, and the workspace will be waiting.";
}

export function inviteHtml(invite: InviteInfo, link: string, name?: string): string {
  return bannerShell(
    BANNER,
    `${greetingLine(name)}
     ${line(`<strong style="color:#111827">${invite.inviterName}</strong> invited you to join a workspace on Quantalog.`)}
     ${infoPanel(invite.workspaceName, roleLine(invite.role), BANNER)}
     ${line(nextStepLine(invite.hasAccount))}
     ${actionButton("Accept invitation", link, BANNER)}
     ${small(`This invitation expires in ${invite.expiresInDays} days. If you weren't expecting it, you can ignore this email — nothing has been shared with you until you accept.`, 18)}
     ${signOff()}`,
  );
}

export function inviteText(invite: InviteInfo, link: string): string {
  return `${invite.inviterName} invited you to the "${invite.workspaceName}" workspace on Quantalog.

${roleLine(invite.role)}

${nextStepLine(invite.hasAccount)}

${link}

This invitation expires in ${invite.expiresInDays} days. If you weren't expecting it, you can ignore this email — nothing has been shared with you until you accept.

The Quantalog Team`;
}
