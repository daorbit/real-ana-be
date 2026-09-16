import {
  bannerShell,
  codeBox,
  greetingLine,
  line,
  signOff,
  small,
  type BannerName,
} from "./shared.js";

const BANNER: BannerName = "verification-code";

export function verificationCodeHtml(code: string, minutes: number, name?: string): string {
  return bannerShell(
    BANNER,
    `${greetingLine(name)}
     ${line("We received a request to verify your Quantalog account. Here is your one-time password (OTP):")}
     ${codeBox(code, BANNER)}
     ${small(`This code expires in ${minutes} minutes.`)}
     ${line("If you didn't request this, you can safely ignore this email. No account has been created.", 18)}
     ${signOff()}`,
  );
}

export function verificationCodeText(code: string, minutes: number, name?: string): string {
  return `Hello${name?.trim() ? ` ${name.trim()}` : ""},

We received a request to verify your Quantalog account. Your verification code is ${code}

It expires in ${minutes} minutes. Enter it on the signup page to finish creating your account.

If you didn't request this, you can safely ignore this email. No account has been created.

The Quantalog Team`;
}
