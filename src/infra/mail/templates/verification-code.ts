import { bigCode, cardLogo, fineprint, layout, pill, rule, strong, text, title } from "./layout.js";

export function verificationCodeHtml(code: string, minutes: number, email?: string): string {
  const who = email ? ` for ${strong(email)}` : "";

  return layout({
    preheader: `Your Quantalog verification code is ${code}. It expires in ${minutes} minutes.`,
    label: "Account security",
    head: `${cardLogo()}
      ${title("Verify your email")}`,
    body: `${text(`Your Quantalog verification code is <span style="font-weight:600;color:#1d1d1f">${code}</span>. Use it to finish creating your account${who}.`)}
      ${bigCode(code)}
      ${pill(`Expires in ${minutes} minutes`)}
      ${rule()}
      ${fineprint("If you didn't request this code, you can ignore this email. Someone may have typed your address by mistake. Never share this code with anyone.")}`,
    legal: "You received this email because a verification code was requested for this address.",
  });
}

export function verificationCodeText(code: string, minutes: number, name?: string): string {
  return `Hi${name?.trim() ? ` ${name.trim()}` : ""},

Your Quantalog verification code is ${code}

Use it to finish creating your account. It expires in ${minutes} minutes and can only be used once.

If you didn't request this code, you can ignore this email. Someone may have typed your address by mistake. Never share this code with anyone.

The Quantalog Team`;
}
