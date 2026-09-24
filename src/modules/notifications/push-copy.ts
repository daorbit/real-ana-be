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

    case "member.removed": {
      const workspace = str(data, "workspaceName", "a workspace");
      return { title: "Access removed", body: `You no longer have access to ${workspace}.` };
    }

    case "role.changed": {
      const workspace = str(data, "workspaceName", "a workspace");
      const role = str(data, "role");
      return {
        title: "Your role changed",
        body: role
          ? `You are now ${role} in ${workspace}.`
          : `Your role in ${workspace} changed.`,
      };
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

    case "payment.failed": {
      const amount = str(data, "amountLabel");
      return {
        title: "Payment failed",
        body: amount
          ? `We couldn't take your payment of ${amount}.`
          : "We couldn't take your payment.",
      };
    }

    case "quota.exceeded": {
      const workspace = str(data, "workspaceName", "Your workspace");
      return {
        title: "Event limit reached",
        body: `${workspace} has used its events for this cycle.`,
      };
    }

    case "seo.audit.done": {
      const site = str(data, "siteName", "your site");
      return { title: "Audit finished", body: `The SEO audit for ${site} is ready.` };
    }

    case "seo.rank.changed": {
      const keyword = str(data, "keyword", "a tracked keyword");
      return { title: "Ranking changed", body: `Your ranking for ${keyword} changed.` };
    }

    case "tracking.stopped": {
      const site = str(data, "siteName", "your site");
      return { title: "Tracking stopped", body: `${site} has stopped sending events.` };
    }

    case "social.post.failed": {
      const channel = str(data, "channel");
      return {
        title: "Post didn't go out",
        body: channel
          ? `A scheduled post to ${channel} failed to send.`
          : "A scheduled post failed to send.",
      };
    }

    case "lead.captured": {
      const form = str(data, "formTitle", "a form");
      return { title: "New lead", body: `A new lead came in on ${form}.` };
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
      const form = str(data, "formTitle", "a form");
      return { title: "New submission", body: `A new response came in on ${form}.` };
    }
  }
}
