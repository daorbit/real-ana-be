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


const DEAD_ENDPOINT_STATUSES = new Set([404, 410]);

export type PushPayload = {
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  notificationId: string;
};


export async function pushToUser(userId: string, payload: PushPayload): Promise<void> {
  const spec = NOTIFICATION_SPECS[payload.type];

  if (!spec?.push) return;

  const mod = await webPush();
  if (!mod) return;

  const subscriptions = await PushSubscription.find({ userId });
  if (!subscriptions.length) return;

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
        );

        void PushSubscription.updateOne(
          { _id: sub._id },
          { $set: { lastSuccessAt: new Date() } },
        ).catch(() => {});
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status && DEAD_ENDPOINT_STATUSES.has(status)) dead.push(endpoint);
      }
    }),
  );

  if (dead.length) {
    await PushSubscription.deleteMany({ endpoint: { $in: dead } }).catch(() => {});
  }
}
