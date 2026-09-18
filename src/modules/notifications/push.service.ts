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


let cached: { mod: WebPushLike | null } | null = null;

type WebPushLike = {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
  ): Promise<unknown>;
};

async function webPush(): Promise<WebPushLike | null> {
  if (cached) return cached.mod;

  if (!pushConfigured()) {
    cached = { mod: null };
    return null;
  }

  try {
    const specifier = "web-push";
    const imported = (await import(/* @vite-ignore */ specifier)) as {
      default?: WebPushLike;
    } & WebPushLike;
    const mod = imported.default ?? imported;

    mod.setVapidDetails(
      process.env.VAPID_SUBJECT as string,
      process.env.VAPID_PUBLIC_KEY as string,
      process.env.VAPID_PRIVATE_KEY as string,
    );
    cached = { mod };
    return mod;
  } catch {
    // The package is not installed. Push stays off; everything else continues.
    cached = { mod: null };
    return null;
  }
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
