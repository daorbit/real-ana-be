import {
  bannerShell,
  codeBox,
  greetingLine,
  line,
  signOff,
  small,
  type BannerName,
} from "./shared.js";

const BANNER: BannerName = "password-reset";

export function passwordResetHtml(code: string, minutes: number, name?: string): string {
  return bannerShell(
    BANNER,
    `${greetingLine(name)}
     ${line("We received a request to reset the password on your Quantalog account. Here is your one-time password (OTP):")}
     ${codeBox(code, BANNER)}
     ${small(`This code expires in ${minutes} minutes.`)}
     ${line("If you didn't ask to reset your password, ignore this email. Your password has not changed, and nobody can change it without this code.", 18)}
     ${signOff()}`,
  );
}

export function passwordResetText(code: string, minutes: number, name?: string): string {
  return `Hello${name?.trim() ? ` ${name.trim()}` : ""},

We received a request to reset the password on your Quantalog account. Your reset code is ${code}

It expires in ${minutes} minutes. Enter it on the password reset page to choose a new password.

If you didn't ask to reset your password, ignore this email. Your password has not changed, and nobody can change it without this code.

The Quantalog Team`;
}
