import { button, footnote, heading, paragraph, shell } from "../../infra/mail/mailer.js";
import { STATUS_LABEL, type IncidentStatus } from "./components.js";
import { apiUrl, siteUrl } from "./urls.js";

const REASON = "You get this because you subscribed to Quantalog status updates.";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function unsubscribeUrl(token: string): string {
  return `${apiUrl()}/api/public/status/unsubscribe?token=${encodeURIComponent(token)}`;
}

export function confirmEmail(token: string) {
  const link = `${apiUrl()}/api/public/status/confirm?token=${encodeURIComponent(token)}`;
  return {
    subject: "Confirm your Quantalog status updates",
    text: [
      "Confirm that you want an email when Quantalog has an incident or planned maintenance:",
      link,
      "",
      "If you did not ask for this, ignore this email and nothing will be sent.",
    ].join("\n"),
    html: shell(
      `${heading("Confirm status updates")}
       ${paragraph("Press the button to get an email whenever Quantalog has an incident or planned maintenance, and each time it is updated.")}
       ${button("Confirm subscription", link)}
       ${footnote("If you did not ask for this, ignore this email and nothing will be sent.")}`,
      "Someone entered this address on the Quantalog status page.",
      "minimal",
    ),
  };
}

export function updateEmail(incident: { id: string; title: string }, update: { status: IncidentStatus; body: string }, token: string) {
  const link = `${siteUrl()}/status/incidents/${incident.id}`;
  const label = STATUS_LABEL[update.status];
  const unsubscribe = unsubscribeUrl(token);
  return {
    subject: `[${label}] ${incident.title}`,
    text: [`${label}: ${incident.title}`, "", update.body, "", `Follow this incident: ${link}`, "", `Stop these emails: ${unsubscribe}`].join("\n"),
    html: shell(
      `${heading(esc(incident.title))}
       ${paragraph(`<b>${esc(label)}</b> · ${esc(update.body).replace(/\n/g, "<br>")}`)}
       ${button("Follow this incident", link)}
       ${footnote(`<a href="${esc(unsubscribe)}">Stop status emails</a>`)}`,
      REASON,
      "minimal",
    ),
    headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}
