import {
  LINKS,
  actionButton,
  bannerShell,
  greetingLine,
  line,
  signOff,
  warningPanel,
  type BannerName,
} from "./shared.js";

const BANNER: BannerName = "password-change";

export function passwordChangeHtml(name?: string): string {
  return bannerShell(
    BANNER,
    `${greetingLine(name)}
     ${line("The password on your Quantalog account was just changed. If that was you, there is nothing to do.")}
     ${warningPanel(
       `<strong style="color:#111827">If it wasn't you</strong>, someone else may have access to your account. Reset your password again straight away, and check that your email account is still secure.`,
     )}
     ${actionButton("Reset your password", `${LINKS.app}/forgot-password`, BANNER)}
     ${signOff()}`,
  );
}

export function passwordChangeText(name?: string): string {
  return `Hello${name?.trim() ? ` ${name.trim()}` : ""},

The password on your Quantalog account was just changed.

If that was you, there is nothing to do.

If it wasn't, your account may be at risk. Reset your password immediately at ${LINKS.app}/forgot-password, and check that your email account is still secure.

The Quantalog Team`;
}
