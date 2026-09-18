import { ROLE_RANK, type WorkspaceRole } from "../workspace/models/Membership.js";

/**
 * Every kind of notification the product can raise, and the rules for who sees
 * one.
 *
 * A single registry rather than a `type` string checked in each emitting call
 * site: the two questions that actually matter — who is eligible, and may they
 * turn it off — have to be answered the same way everywhere, and a table is the
 * only shape where "billing goes to admins" can't drift apart from the code
 * that fans it out.
 *
 * Notifications deliberately store `type` and `data`, not rendered prose. The
 * dashboard ships ten locales; a row carrying an English sentence is a row that
 * can never be read in any of the other nine. The strings live in the client's
 * dictionaries, keyed off `type`. `admin.message` is the one exception, and the
 * reason is written on it below.
 */

export const NOTIFICATION_TYPES = [
  "invite.received",
  "invite.accepted",
  "report.ready",
  "plan.ending",
  "payment.received",
  "seo.audit.done",
  "admin.message",
  "security.alert",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * How a type finds its recipients.
 *
 * - `workspace` — fanned out to the members of one workspace whose role is at
 *   least `minRole`. The row carries `workspaceId`.
 * - `user`      — addressed to one person, with no workspace behind it
 *   (security notices, an invitation to a workspace they are not in yet).
 */
export type NotificationScope = "workspace" | "user";

export type NotificationSpec = {
  scope: NotificationScope;
  /**
   * The weakest role that should hear about this. Only meaningful for
   * `workspace` scope.
   *
   * This is the field that keeps money off a viewer's screen: a read-only seat
   * shared with a client has no business being told what the agency pays.
   */
  minRole: WorkspaceRole;
  /**
   * Whether a user may switch this off.
   *
   * False on `security.alert` on purpose. "Your password was changed" is the
   * one message whose whole value is reaching someone who did not expect it,
   * and an attacker who has the account would mute it first.
   */
  optional: boolean;
  /**
   * Whether this type is eligible for browser push, for users who granted
   * permission.
   *
   * Off for the routine ones. A push is an interruption — it lights a phone on
   * a desk — and a finished SEO crawl does not earn that. The bell is where
   * "something happened" belongs; push is for "something happened that you
   * would want to stop what you are doing for".
   */
  push: boolean;
  /**
   * Whether the product already sends an email for this by another path.
   *
   * Nothing here reads it yet — notifications send no mail in v1. It is
   * recorded now because the answer is easy to establish today, while the
   * sending code is in front of us, and genuinely hard to reconstruct later:
   * wiring email into notifications without it would double-send every type
   * marked true.
   */
  mailedElsewhere: boolean;
};

export const NOTIFICATION_SPECS: Record<NotificationType, NotificationSpec> = {
  /** Someone invited you to a workspace. You may not be a member yet — that is the point. */
  "invite.received": { scope: "user", minRole: "viewer", optional: true, push: true, mailedElsewhere: true },
  /** Someone you invited accepted. Goes to the admins who can act on the membership. */
  "invite.accepted": { scope: "workspace", minRole: "admin", optional: true, push: false, mailedElsewhere: false },
  /** A scheduled report finished and is ready to read. */
  "report.ready": { scope: "workspace", minRole: "viewer", optional: true, push: false, mailedElsewhere: true },
  /** A paid plan is within days of lapsing. Whoever can renew it should hear this. */
  "plan.ending": { scope: "workspace", minRole: "admin", optional: true, push: true, mailedElsewhere: true },
  "payment.received": { scope: "workspace", minRole: "admin", optional: true, push: false, mailedElsewhere: true },
  "seo.audit.done": { scope: "workspace", minRole: "viewer", optional: true, push: false, mailedElsewhere: false },
  /**
   * A message written by a platform admin and sent to chosen recipients.
   *
   * The one type that stores its own prose, because there is nothing to key a
   * translation off: an admin types a subject and a body into a form minutes
   * before it goes out. `data` therefore carries `{ subject, body, cta }` and
   * the client renders them as given.
   */
  "admin.message": { scope: "user", minRole: "viewer", optional: true, push: true, mailedElsewhere: true },
  /**
   * Something changed on the account that the holder should verify was them —
   * a password change, a lockout, an admin resetting 2FA.
   */
  "security.alert": { scope: "user", minRole: "viewer", optional: false, push: true, mailedElsewhere: true },
};

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === "string" && value in NOTIFICATION_SPECS;
}

/**
 * Whether a member holding `role` is senior enough to receive `type`.
 *
 * Leans on `ROLE_RANK` rather than listing roles per type, for the reason given
 * there: the roles are cumulative, and saying so once is what stops two lists
 * disagreeing about whether an owner counts as an admin.
 */
export function roleMayReceive(type: NotificationType, role: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[NOTIFICATION_SPECS[type].minRole];
}
