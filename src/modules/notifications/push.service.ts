import webPushLib from "web-push";
import { PushSubscription } from "./models/PushSubscription.js";
import { NOTIFICATION_SPECS, type NotificationType } from "./types.js";


export function vapidPublicKey(): string {
  return process.env.VAPID_PUBLIC_KEY || "";
}


export function pushConfigured(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY &&
      process.env.VAPID_PRIVATE_KEY &&
      process.env.VAPID_SUBJECT,
  );
}


let configured = false;

function webPush(): typeof webPushLib | null {
  if (!pushConfigured()) return null;

  if (!configured) {
    webPushLib.setVapidDetails(
      process.env.VAPID_SUBJECT as string,
      process.env.VAPID_PUBLIC_KEY as string,
      process.env.VAPID_PRIVATE_KEY as string,
    );
    configured = true;
  }

  return webPushLib;
}


const DEAD_ENDPOINT_STATUSES = new Set([403, 404, 410]);

export type PushPayload = {
  type: NotificationType | "test";
  title: string;
  body: string;
  link: string;
  notificationId: string;
};

export type PushResult = {
  subscriptions: number;
  sent: number;
  failed: number;
  errors: string[];
};

async function sendToAll(userId: string, payload: PushPayload): Promise<PushResult> {
  const result: PushResult = { subscriptions: 0, sent: 0, failed: 0, errors: [] };

  const mod = webPush();
  if (!mod) return result;

  const subscriptions = await PushSubscription.find({ userId });
  result.subscriptions = subscriptions.length;
  if (!subscriptions.length) return result;

  const body = JSON.stringify(payload);
  const dead: string[] = [];

  await Promise.all(
    subscriptions.map(async (sub) => {
      const endpoint = String(sub.get("endpoint"));
      try {
        await mod.sendNotification(
          {
            endpoint,
            keys: { p256dh: String(sub.get("p256dh")), auth: String(sub.get("auth")) },
          },
          body,
          { TTL: 60 * 60 },
        );
        result.sent++;

        void PushSubscription.updateOne(
          { _id: sub._id },
          { $set: { lastSuccessAt: new Date() } },
        ).catch(() => {});
      } catch (err) {
        const { statusCode, body: errBody, message } = err as {
          statusCode?: number;
          body?: string;
          message?: string;
        };
        result.failed++;
        result.errors.push(`${statusCode ?? "error"}: ${(errBody || message || "").slice(0, 200)}`);
        console.warn(
          `[push] send failed for user ${userId} (${statusCode ?? "no status"}): ${errBody || message}`,
        );
        if (statusCode && DEAD_ENDPOINT_STATUSES.has(statusCode)) dead.push(endpoint);
      }
    }),
  );

  if (dead.length) {
    await PushSubscription.deleteMany({ endpoint: { $in: dead } }).catch(() => {});
  }

  return result;
}

export async function pushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (payload.type !== "test" && !NOTIFICATION_SPECS[payload.type]?.push) return;
  await sendToAll(userId, payload);
}

export function sendTestPush(userId: string): Promise<PushResult> {
  return sendToAll(userId, {
    type: "test",
    title: "Push notifications are working",
    body: "You'll get alerts like this on this device, even when Quantalog is closed.",
    link: "/app/settings/notifications",
    notificationId: `test-${Date.now()}`,
  });
}
