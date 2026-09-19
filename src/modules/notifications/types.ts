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
  "member.removed",
  "role.changed",
  "report.ready",
  "plan.ending",
  "payment.received",
  "payment.failed",
  "quota.exceeded",
  "seo.audit.done",
  "seo.rank.changed",
  "tracking.stopped",
  "social.post.failed",
  "lead.captured",
  "admin.message",
  "security.alert",
  "form.submission",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];


export type NotificationScope = "workspace" | "user";

export type NotificationSpec = {
  scope: NotificationScope;

  minRole: WorkspaceRole;

  optional: boolean;

  push: boolean;

  mailedElsewhere: boolean;
};

export const NOTIFICATION_SPECS: Record<NotificationType, NotificationSpec> = {
  /** Someone invited you to a workspace. You may not be a member yet — that is the point. */
  "invite.received": { scope: "user", minRole: "viewer", optional: true, push: true, mailedElsewhere: true },
  /** Someone you invited accepted. Goes to the admins who can act on the membership. */
  "invite.accepted": { scope: "workspace", minRole: "admin", optional: true, push: false, mailedElsewhere: false },
  /**
   * Your access to a workspace was withdrawn.
   *
   * Addressed to the person who lost it, so `user` scope — by the time this
   * sends they are not a member and a workspace fan-out would not reach them.
   * Not optional: silently losing access is the kind of thing someone has to
   * be told, or they are left staring at a workspace that has vanished.
   */
  "member.removed": { scope: "user", minRole: "viewer", optional: false, push: false, mailedElsewhere: false },
  /** Your role in a workspace changed — what you may do changed with it. */
  "role.changed": { scope: "user", minRole: "viewer", optional: false, push: false, mailedElsewhere: false },
  /** A scheduled report finished and is ready to read. */
  "report.ready": { scope: "workspace", minRole: "viewer", optional: true, push: false, mailedElsewhere: true },
  /** A paid plan is within days of lapsing. Whoever can renew it should hear this. */
  "plan.ending": { scope: "workspace", minRole: "admin", optional: true, push: true, mailedElsewhere: true },
  "payment.received": { scope: "workspace", minRole: "admin", optional: true, push: false, mailedElsewhere: true },
  /**
   * A charge did not go through.
   *
   * Not optional, and pushed, unlike its successful twin: a receipt is a record
   * to file, while a failure is a deadline — the plan lapses if nobody acts.
   */
  "payment.failed": { scope: "workspace", minRole: "admin", optional: false, push: true, mailedElsewhere: true },
  /**
   * The workspace hit its event cap. Whoever can raise the plan should hear it,
   * and it is not optional — past the cap, data is being dropped.
   */
  "quota.exceeded": { scope: "workspace", minRole: "admin", optional: false, push: true, mailedElsewhere: true },
  "seo.audit.done": { scope: "workspace", minRole: "viewer", optional: true, push: false, mailedElsewhere: false },
  /** A tracked competitor overtook you, or you them, on a watched keyword. */
  "seo.rank.changed": { scope: "workspace", minRole: "viewer", optional: true, push: false, mailedElsewhere: false },
  /**
   * The site stopped sending events.
   *
   * The most important row in this table: every other failure is visible in the
   * dashboard, while this one looks exactly like a quiet week. Pushed, and not
   * optional — data lost while it goes unnoticed cannot be backfilled.
   */
  "tracking.stopped": { scope: "workspace", minRole: "editor", optional: false, push: true, mailedElsewhere: true },
  /** A scheduled post did not go out. Whoever scheduled it thinks it did. */
  "social.post.failed": { scope: "workspace", minRole: "editor", optional: false, push: false, mailedElsewhere: true },
  /** A new lead came in through a capture form — same shape as a submission. */
  "lead.captured": { scope: "workspace", minRole: "editor", optional: true, push: false, mailedElsewhere: true },

  "admin.message": { scope: "user", minRole: "viewer", optional: true, push: true, mailedElsewhere: true },

  "security.alert": { scope: "user", minRole: "viewer", optional: false, push: true, mailedElsewhere: true },

  "form.submission": { scope: "workspace", minRole: "editor", optional: true, push: false, mailedElsewhere: true },
};

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === "string" && value in NOTIFICATION_SPECS;
}


export function roleMayReceive(type: NotificationType, role: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[NOTIFICATION_SPECS[type].minRole];
}
