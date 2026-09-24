import { Router, Response } from "express";
import { Types } from "mongoose";
import { Notification } from "../../modules/notifications/models/Notification.js";
import { NotificationPref } from "../../modules/notifications/models/NotificationPref.js";
import { PushSubscription } from "../../modules/notifications/models/PushSubscription.js";
import {
  NOTIFICATION_SPECS,
  NOTIFICATION_TYPES,
  isNotificationType,
} from "../../modules/notifications/types.js";
import {
  vapidPublicKey,
  pushConfigured,
  sendTestPush,
} from "../../modules/notifications/push.service.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);
router.use(blockDemoWrites);

/** How many rows one page of the feed returns, and the ceiling on asking for more. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function present(row: InstanceType<typeof Notification>) {
  return {
    id: row.id,
    type: row.get("type"),
    data: row.get("data") ?? {},
    link: row.get("link") ?? "",
    workspaceId: row.get("workspaceId") ? String(row.get("workspaceId")) : null,
    actorId: row.get("actorId") ? String(row.get("actorId")) : null,
    seenAt: row.get("seenAt"),
    readAt: row.get("readAt"),
    createdAt: row.get("createdAt"),
  };
}

router.get("/unread-count", async (req: AuthedRequest, res: Response) => {
  const count = await Notification.countDocuments({ userId: req.userId, readAt: null });
  res.json({ count });
});

router.get("/", async (req: AuthedRequest, res: Response) => {
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT),
  );

  const filter: Record<string, unknown> = { userId: req.userId };

  if (req.query.unread === "true") filter.readAt = null;

  if (req.query.cursor) {
    const cursor = new Date(String(req.query.cursor));
    if (Number.isNaN(cursor.getTime()))
      return res.status(400).json({ error: "cursor must be a valid date" });
    filter.createdAt = { $lt: cursor };
  }

  const rows = await Notification.find(filter).sort({ createdAt: -1 }).limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  res.json({
    items: page.map(present),
    nextCursor: hasMore ? page[page.length - 1].get("createdAt") : null,
  });
});

router.post("/seen", async (req: AuthedRequest, res: Response) => {
  await Notification.updateMany(
    { userId: req.userId, seenAt: null },
    { $set: { seenAt: new Date() } },
  );
  res.json({ ok: true });
});

router.post("/read", async (req: AuthedRequest, res: Response) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: "ids is required" });
  if (ids.length > MAX_LIMIT)
    return res.status(400).json({ error: `no more than ${MAX_LIMIT} ids at once` });

  const valid = ids
    .map((id: unknown) => String(id))
    .filter((id: string) => Types.ObjectId.isValid(id));
  if (!valid.length) return res.status(400).json({ error: "no valid ids" });

  const now = new Date();
  await Notification.updateMany(
    { _id: { $in: valid }, userId: req.userId, readAt: null },
    { $set: { readAt: now, seenAt: now } },
  );

  res.json({ ok: true });
});

router.post("/unread", async (req: AuthedRequest, res: Response) => {
  const id = String(req.body?.id ?? "");
  if (!Types.ObjectId.isValid(id)) return res.status(400).json({ error: "a valid id is required" });

  await Notification.updateOne(
    { _id: id, userId: req.userId },
    { $set: { readAt: null } },
  );

  res.json({ ok: true });
});

router.post("/read-all", async (req: AuthedRequest, res: Response) => {
  const now = new Date();
  await Notification.updateMany(
    { userId: req.userId, readAt: null },
    { $set: { readAt: now, seenAt: now } },
  );
  res.json({ ok: true });
});

router.post("/delete", async (req: AuthedRequest, res: Response) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: "ids is required" });
  if (ids.length > MAX_LIMIT)
    return res.status(400).json({ error: `no more than ${MAX_LIMIT} ids at once` });

  const valid = ids
    .map((id: unknown) => String(id))
    .filter((id: string) => Types.ObjectId.isValid(id));
  if (!valid.length) return res.status(400).json({ error: "no valid ids" });

  await Notification.deleteMany({ _id: { $in: valid }, userId: req.userId });

  res.json({ ok: true });
});

router.get("/preferences", async (req: AuthedRequest, res: Response) => {
  const overrides = await NotificationPref.find({ userId: req.userId });
  const byType = new Map(overrides.map((row) => [String(row.get("type")), row]));

  res.json({
    pushConfigured: pushConfigured(),
    vapidPublicKey: vapidPublicKey(),
    items: NOTIFICATION_TYPES.map((type) => {
      const spec = NOTIFICATION_SPECS[type];
      const override = byType.get(type);
      return {
        type,
        optional: spec.optional,
        pushable: spec.push,
        inApp: spec.optional ? (override?.get("inApp") ?? true) : true,
        push: spec.optional ? (override?.get("push") ?? true) : true,
      };
    }),
  });
});

router.patch("/preferences", async (req: AuthedRequest, res: Response) => {
  const type = req.body?.type;
  if (!isNotificationType(type)) return res.status(400).json({ error: "unknown notification type" });

  // A non-optional type has no switch to flip. Refusing rather than silently
  // accepting-and-ignoring: a client that thinks it muted security alerts
  // should find out here, not from the next alert arriving anyway.
  if (!NOTIFICATION_SPECS[type].optional)
    return res.status(400).json({ error: "this notification type cannot be turned off" });

  const update: Record<string, boolean> = {};
  if (typeof req.body?.inApp === "boolean") update.inApp = req.body.inApp;
  if (typeof req.body?.push === "boolean") update.push = req.body.push;
  if (!Object.keys(update).length) return res.status(400).json({ error: "nothing to update" });

  await NotificationPref.updateOne(
    { userId: req.userId, type },
    { $set: update },
    { upsert: true },
  );

  res.json({ ok: true });
});

router.post("/push/subscribe", async (req: AuthedRequest, res: Response) => {
  const endpoint = String(req.body?.endpoint ?? "").trim();
  const p256dh = String(req.body?.keys?.p256dh ?? "").trim();
  const auth = String(req.body?.keys?.auth ?? "").trim();

  if (!endpoint || !p256dh || !auth)
    return res.status(400).json({ error: "endpoint and keys are required" });
  if (!/^https:\/\//i.test(endpoint))
    return res.status(400).json({ error: "endpoint must be an https URL" });

  await PushSubscription.updateOne(
    { endpoint },
    {
      $set: {
        userId: req.userId,
        p256dh,
        auth,
        userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200),
      },
    },
    { upsert: true },
  );

  res.json({ ok: true });
});

router.post("/push/test", async (req: AuthedRequest, res: Response) => {
  if (!pushConfigured()) {
    return res.status(503).json({ error: "Push notifications aren't set up on this server." });
  }
  const result = await sendTestPush(String(req.userId));
  if (!result.subscriptions) {
    return res.status(409).json({
      error: "This account has no registered browsers. Turn browser notifications off and on again.",
      ...result,
    });
  }
  if (!result.sent) {
    return res.status(502).json({
      error: "The push service rejected the notification. Turn browser notifications off and on again.",
      ...result,
    });
  }
  res.json(result);
});

router.post("/push/unsubscribe", async (req: AuthedRequest, res: Response) => {
  const endpoint = String(req.body?.endpoint ?? "").trim();
  if (!endpoint) return res.status(400).json({ error: "endpoint is required" });

  await PushSubscription.deleteOne({ endpoint, userId: req.userId });
  res.json({ ok: true });
});

export default router;
