import type { NotificationType } from "./types.js";

/**
 * English titles and bodies, for browser push only.
 *
 * The panel renders from `type` and `data` against the client's dictionaries,
 * in whichever of the ten locales the user reads. A push notification cannot:
 * it is drawn by the operating system from a payload the service worker
 * receives, with no access to the app's translations and often with the app not
 * running at all.
 *
 * So the strings here exist because push has nowhere else to get them, and they
 * are the only user-facing prose the backend owns. They are kept deliberately
 * short — a push is truncated by the OS at a length nobody controls — and
 * deliberately vague about specifics that would be stale by the time someone
 * taps the notification.
 */

type Data = Record<string, unknown>;

function str(data: Data, key: string, fallback = ""): string {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function pushCopy(type: NotificationType, data: Data): { title: string; body: string } {
  switch (type) {
    case "invite.received": {
      const workspace = str(data, "workspaceName", "a workspace");
      const inviter = str(data, "inviterName");
      return {
        title: "You've been invited",
        body: inviter
          ? `${inviter} invited you to ${workspace}.`
          : `You've been invited to ${workspace}.`,
      };
    }

    case "invite.accepted": {
      const who = str(data, "actorName", "Someone");
      const workspace = str(data, "workspaceName", "your workspace");
      return { title: "Invitation accepted", body: `${who} joined ${workspace}.` };
    }

    case "report.ready": {
      const name = str(data, "reportName", "Your report");
      return { title: "Report ready", body: `${name} has finished and is ready to read.` };
    }

    case "plan.ending": {
      const workspace = str(data, "workspaceName", "your workspace");
      const days = Number(data.daysLeft);
      const when = !Number.isFinite(days)
        ? "soon"
        : days <= 1
          ? "tomorrow"
          : `in ${days} days`;
      return { title: "Plan ending", body: `The plan for ${workspace} ends ${when}.` };
    }

    case "payment.received": {
      const amount = str(data, "amountLabel");
      return {
        title: "Payment received",
        body: amount ? `We received your payment of ${amount}.` : "We received your payment.",
      };
    }

    case "seo.audit.done": {
      const site = str(data, "siteName", "your site");
      return { title: "Audit finished", body: `The SEO audit for ${site} is ready.` };
    }

    case "admin.message": {
      // The one type whose prose is authored rather than translated — an admin
      // typed it into a form. See the note on it in `types.ts`.
      return {
        title: str(data, "subject", "A message from Quantalog"),
        body: str(data, "body").slice(0, 160),
      };
    }

    case "security.alert": {
      return {
        title: "Security alert",
        body: str(data, "what", "Something changed on your account."),
      };
    }

    case "form.submission": {
      // Never actually sent — the type's `push: false` in the registry stops
      // `deliver` from calling this. Present for the switch's exhaustiveness.
      const form = str(data, "formTitle", "a form");
      return { title: "New submission", body: `A new response came in on ${form}.` };
    }
  }
}
