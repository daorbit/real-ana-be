/**
 * The canned messages an admin can start from.
 *
 * Kept server-side so the composer and any future automation read the same
 * copy, and so wording can be corrected without shipping a frontend build.
 *
 * Written short on purpose. These go to people who did not ask to hear from
 * us, so every one of them says who it's from, why it arrived, what to do, and
 * stops — a nudge that opens with three paragraphs of positioning gets deleted
 * before the ask is reached.
 */

import type { BodyLayout } from "./mail.js";

export type MailTemplate = {
  id: string;
  /** Shown on the picker. */
  label: string;
  /** One line on what it's for, so the right one is picked without opening it. */
  hint: string;
  /**
   * The segment this is written for; the composer preselects it.
   *
   * "custom" means the message is not addressed at existing accounts at all —
   * the composer switches to hand-entered addresses instead of a user list.
   */
  segment: "all" | "not-installed" | "no-sites" | "installed" | "custom";
  subject: string;
  body: string;
  /**
   * Which body layout the renderer should use.
   *
   * Templates are plain text by default — that is right for a message an admin
   * writes themselves, where invented structure would put words in their mouth.
   * The canned ones name a layout instead, because each is always about the
   * same thing and prose alone was doing that thing badly: an install reminder
   * that only describes the snippet is asking a reader to go and find something
   * they have already not gone and found.
   *
   * Every layout except "plain" needs a `cta` and falls back to plain prose
   * without one.
   */
  layout?: BodyLayout;
  /**
   * The action the message is asking for.
   *
   * Rendered as a button under the text. Optional — a message that only asks
   * for a reply has nowhere to send anyone, and a button pointing at the
   * dashboard for the sake of having one is noise.
   */
  cta?: { label: string; href: string };
};

/** Where template buttons point. Same env overrides the mail shell uses. */
const APP_URL = process.env.PUBLIC_APP_URL || "https://studio-quantalog.daorbit.in";
const SITE_URL = process.env.PUBLIC_SITE_URL || "https://quantalog.daorbit.in";

export const MAIL_TEMPLATES: MailTemplate[] = [
  {
    id: "install-reminder",
    label: "Install reminder",
    hint: "Added a site but never sent an event",
    segment: "not-installed",
    layout: "install",
    subject: "Your Quantalog site isn't reporting yet",
    // Short on purpose: the snippet and the two steps come from the layout, so
    // describing them here would say everything twice.
    body: `Hi {{name}},

You set up a site on Quantalog, but no traffic has come through yet — which almost always means the tracking snippet isn't on the page.

Stuck? Reply to this email and I'll take a look.`,
    cta: { label: "Get my snippet", href: `${APP_URL}/app` },
  },
  {
    id: "welcome",
    label: "Welcome",
    hint: "Signed up but never added a site",
    segment: "no-sites",
    layout: "welcome",
    subject: "Welcome to Quantalog",
    // The three steps come from the layout. This says why they're worth taking.
    body: `Hi {{name}},

Thanks for signing up. You're three short steps from live traffic, and none of them involve a cookie banner.

If anything's unclear, just reply. I read every message.`,
    cta: { label: "Add my first site", href: `${APP_URL}/app/onboarding` },
  },
  {
    id: "check-in",
    label: "Check in",
    hint: "Ask an active user how it's going",
    segment: "installed",
    subject: "How's Quantalog working out?",
    body: `Hi {{name}},

You've had Quantalog running for a little while now, so I wanted to ask directly: is it giving you what you need?

If something's missing or in your way, reply and tell me. It genuinely shapes what I build next.`,
    // No button: this asks for a reply, and a dashboard link would compete
    // with the one thing it wants.
  },
  {
    id: "feature-seo",
    label: "SEO audits",
    hint: "Point active users at a feature they may not have found",
    segment: "installed",
    layout: "feature",
    subject: "You've got SEO audits built in",
    // The checklist comes from the layout, so this only has to say where the
    // feature is and that it needs no setup.
    body: `Hi {{name}},

Quick one — since you're already tracking traffic, you may not have noticed the SEO side of Quantalog.

It's under SEO in your dashboard, it works on any site you've added, and the report is shareable.`,
    cta: { label: "Run an audit", href: `${APP_URL}/app/seo` },
  },
  {
    id: "invite",
    label: "Invitation",
    hint: "Introduce Quantalog to someone who doesn't have an account",
    // Not an existing-user segment: this is addressed at people who are not in
    // the database, so the composer collects addresses by hand.
    segment: "custom",
    // The feature list and closing note come from the renderer; the body here is
    // only the opening, which is what an admin should be personalising.
    layout: "invite",
    subject: "Analytics without the cookie banner",
    // `{{greeting}}` rather than "Hi {{name}}": most invitations go to a bare
    // address, and greeting a stranger by the local part of their email is the
    // clearest possible signal that a machine sent this.
    body: `{{greeting}},

I thought Quantalog might be useful to you.

It's real-time web analytics that needs one script tag and no consent banner — built because the alternatives were either heavyweight and slow, or priced for companies with a data team.`,
    cta: { label: "Start free", href: `${APP_URL}/signup` },
  },
];

export { SITE_URL };
