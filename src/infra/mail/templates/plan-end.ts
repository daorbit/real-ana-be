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

const BANNER: BannerName = "plan-end";

export type PlanInfo = {
  workspaceName: string;
  planName: string;
  daysLeft: number;
};

export function planEndHtml(
  info: PlanInfo,
  link: string,
  when: string,
  endsOn: string,
  name?: string,
): string {
  return bannerShell(
    BANNER,
    `${greetingLine(name)}
     ${line(`The <strong style="color:#111827">${info.planName}</strong> plan for this workspace ends ${when}.`)}
     ${infoPanel(info.workspaceName, `Ends on ${endsOn}`, BANNER)}
     ${line("Plans do not renew automatically, so nothing will be charged. When the period ends the workspace drops to the Free plan — tracking continues at Free's allowance and everything already collected stays readable, but the paid features stop.")}
     ${actionButton("Renew plan", link, BANNER)}
     ${small("If you have already renewed, or meant to let this lapse, you can ignore this email.", 18)}
     ${signOff()}`,
  );
}

export function planEndText(
  info: PlanInfo,
  link: string,
  when: string,
  endsOn: string,
  name?: string,
): string {
  return `Hello${name?.trim() ? ` ${name.trim()}` : ""},

Your ${info.planName} plan for "${info.workspaceName}" ends ${when}, on ${endsOn}.

Plans do not renew automatically, so nothing will be charged. When the period ends the workspace drops to the Free plan: tracking continues at Free's allowance and everything already collected stays readable, but the paid features stop.

Renew here: ${link}

The Quantalog Team`;
}
