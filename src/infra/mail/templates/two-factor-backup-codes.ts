import {
  LINKS,
  bannerShell,
  greetingLine,
  line,
  signOff,
  warningPanel,
  escapeHtml,
  C,
  FONT,
  THEMES,
  type BannerName,
} from "./shared.js";

const BANNER: BannerName = "two-factor-backup-codes";

/** A two-column grid of monospace codes, styled like the other card panels. */
function codesGrid(codes: string[]): string {
  const theme = THEMES[BANNER];
  const rows: string[] = [];
  for (let i = 0; i < codes.length; i += 2) {
    const left = codes[i];
    const right = codes[i + 1];
    rows.push(`<tr>
      <td width="50%" style="padding:6px 8px 6px 0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;color:${C.text}">${escapeHtml(left)}</td>
      ${right ? `<td width="50%" style="padding:6px 0 6px 8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;color:${C.text}">${escapeHtml(right)}</td>` : "<td></td>"}
    </tr>`);
  }

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:14px 0 0">
    <tr><td style="background:${C.panel};border:1px solid ${theme.edge};border-radius:10px;padding:18px 20px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows.join("")}</table>
    </td></tr>
  </table>`;
}

export function twoFactorBackupCodesHtml(codes: string[], name?: string): string {
  return bannerShell(
    BANNER,
    `${greetingLine(name)}
     ${line("Two-factor authentication is now on for your Quantalog account. These backup codes let you sign in if you ever lose access to your authenticator app — each one works once, in place of a live code.")}
     ${codesGrid(codes)}
     ${warningPanel(
       `<strong style="color:${C.text}">Keep these somewhere safe</strong> — anyone with a code and your password can sign in. They won't be shown again after this email, in your account or anywhere else.`,
     )}
     ${line(`Turn two-factor authentication off any time from <a href="${LINKS.app}/app/settings/security" style="color:${THEMES[BANNER].accentDeep};font-weight:600;text-decoration:none">Settings</a> if you no longer want it.`, 18)}
     ${signOff()}`,
  );
}

export function twoFactorBackupCodesText(codes: string[], name?: string): string {
  return `Hello${name?.trim() ? ` ${name.trim()}` : ""},

Two-factor authentication is now on for your Quantalog account. These backup codes let you sign in if you ever lose access to your authenticator app — each one works once, in place of a live code.

${codes.join("\n")}

Keep these somewhere safe — anyone with a code and your password can sign in. They won't be shown again after this email, in your account or anywhere else.

Turn two-factor authentication off any time from Settings if you no longer want it: ${LINKS.app}/app/settings/security

The Quantalog Team`;
}
