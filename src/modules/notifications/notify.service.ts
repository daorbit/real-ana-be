import { Membership, ROLE_RANK, type WorkspaceRole } from "../workspace/models/Membership.js";
import { Notification } from "./models/Notification.js";
import { NotificationPref } from "./models/NotificationPref.js";
import { pushToUser } from "./push.service.js";
import { pushCopy } from "./push-copy.js";
import { NOTIFICATION_SPECS, roleMayReceive, type NotificationType } from "./types.js";

/**
 * The only way notifications are created.
 *
 * Domain code calls `emit` or `emitTo` and nothing else — no route, cron or
 * webhook touches the `Notification` model directly. The eligibility rules are
 * the reason: who is senior enough to hear about a payment, who muted what,
 * whether the person who caused an event should be told about it. Answering
 * those at each call site is how a viewer eventually ends up reading the
 * agency's invoice.
 *
 * ## Nothing here is allowed to break its caller
 *
 * Every exported function swallows its own errors. The callers are a payment
 * webhook, an invite acceptance, a report run — operations whose success is
 * already decided by the time a notification is due. A failed insert must not
 * roll back a payment that Razorpay considers complete, and a push service
 * having a bad afternoon must not turn a successful crawl into a 500.
 *
 * This is a deliberate trade: a lost notification is invisible and recoverable
 * (the underlying record still exists, and the user will see it where it
 * lives), where a failed webhook is neither.
 */

type Data = Record<string, unknown>;

export type EmitWorkspaceArgs = {
  type: NotificationType;
  workspaceId: string;
  data?: Data;
  /** Dashboard-relative path the row links to. */
  link?: string;
  /**
   * Who performed the action, when a person did.
   *
   * Excluded from the fan-out: being told you accepted your own invitation is
   * noise, and it is the kind of noise that teaches people to ignore the bell.
   */
  actorId?: string | null;
  /**
   * Narrow the recipients further than the type's own `minRole`.
   *
   * For the rare event that concerns one role in one instance — not a property
   * of the type, so it does not belong in the registry.
   */
  minRole?: WorkspaceRole;
};

export type EmitUserArgs = {
  type: NotificationType;
  userId: string;
  data?: Data;
  link?: string;
  actorId?: string | null;
};

/**
 * Which of these users have switched this type off.
 *
 * One query for the whole fan-out rather than one per recipient, and absence is
 * the default — a user with no row wants whatever the registry says. A type the
 * registry marks non-optional ignores stored preferences entirely, which is
 * what makes a security notice unmutable rather than merely defaulted-on.
 */
async function filterByPrefs(
  userIds: string[],
  type: NotificationType,
  channel: "inApp" | "push",
): Promise<Set<string>> {
  const allowed = new Set(userIds);
  if (!NOTIFICATION_SPECS[type].optional) return allowed;

  const prefs = await NotificationPref.find({ userId: { $in: userIds }, type }).select(
    `userId ${channel}`,
  );

  for (const pref of prefs) {
    if (pref.get(channel) === false) allowed.delete(String(pref.get("userId")));
  }

  return allowed;
}

/**
 * Write the rows and fire the pushes for a resolved recipient list.
 *
 * Push is intentionally not awaited into the caller's critical path beyond this
 * function: `insertMany` is what makes the notification real, and a push is a
 * best-effort courtesy on top of a row that already exists.
 */
async function deliver(
  userIds: string[],
  args: { type: NotificationType; workspaceId?: string | null; data: Data; link: string; actorId?: string | null },
): Promise<void> {
  if (!userIds.length) return;

  const inApp = await filterByPrefs(userIds, args.type, "inApp");
  if (!inApp.size) return;

  const recipients = [...inApp];

  const rows = await Notification.insertMany(
    recipients.map((userId) => ({
      userId,
      workspaceId: args.workspaceId ?? null,
      type: args.type,
      data: args.data,
      link: args.link,
      actorId: args.actorId ?? null,
    })),
    // One bad row (a recipient deleted mid-fan-out) should not cost the rest
    // their notification.
    { ordered: false },
  );

  if (!NOTIFICATION_SPECS[args.type].push) return;

  const pushable = await filterByPrefs(recipients, args.type, "push");
  if (!pushable.size) return;

  const copy = pushCopy(args.type, args.data);

  await Promise.all(
    rows
      .filter((row) => pushable.has(String(row.get("userId"))))
      .map((row) =>
        pushToUser(String(row.get("userId")), {
          type: args.type,
          title: copy.title,
          body: copy.body,
          link: args.link,
          notificationId: String(row._id),
        }),
      ),
  );
}

/**
 * Notify the members of a workspace who are senior enough to hear it.
 *
 * Membership is read fresh on every emit rather than cached: someone demoted
 * this morning must stop receiving billing notices this morning, which is the
 * same reasoning that keeps roles out of the JWT.
 */
export async function emit(args: EmitWorkspaceArgs): Promise<void> {
  try {
    const memberships = await Membership.find({ workspaceId: args.workspaceId }).select(
      "userId role",
    );

    const recipients = memberships
      .filter((m) => {
        const role = m.get("role") as WorkspaceRole;
        // The registry's floor always applies; `minRole` can only raise it, so
        // a call site can be stricter than the type but never looser.
        if (!roleMayReceive(args.type, role)) return false;
        return args.minRole ? ROLE_RANK[role] >= ROLE_RANK[args.minRole] : true;
      })
      .map((m) => String(m.get("userId")))
      .filter((userId) => userId !== String(args.actorId ?? ""));

    await deliver(recipients, {
      type: args.type,
      workspaceId: args.workspaceId,
      data: args.data ?? {},
      link: args.link ?? "",
      actorId: args.actorId,
    });
  } catch {
    // See the note at the top of the file: notifications never fail a caller.
  }
}

/**
 * Notify one specific person, with no workspace membership behind it.
 *
 * For notices addressed to an account rather than a role: a security alert, or
 * an invitation to a workspace the recipient is by definition not yet in.
 */
export async function emitTo(args: EmitUserArgs): Promise<void> {
  try {
    if (String(args.userId) === String(args.actorId ?? "")) return;

    await deliver([String(args.userId)], {
      type: args.type,
      workspaceId: null,
      data: args.data ?? {},
      link: args.link ?? "",
      actorId: args.actorId,
    });
  } catch {
    // Swallowed, as above.
  }
}

/**
 * Notify several named people at once.
 *
 * Exists for the admin broadcast, which resolves its recipients from a list of
 * email addresses rather than from a workspace: the same delivery rules apply,
 * but there is no membership to read.
 */
export async function emitToMany(
  userIds: string[],
  args: Omit<EmitUserArgs, "userId">,
): Promise<void> {
  try {
    const recipients = [...new Set(userIds.map(String))].filter(
      (userId) => userId !== String(args.actorId ?? ""),
    );

    await deliver(recipients, {
      type: args.type,
      workspaceId: null,
      data: args.data ?? {},
      link: args.link ?? "",
      actorId: args.actorId,
    });
  } catch {
    // Swallowed, as above.
  }
}
