import { User } from "../identity/models/User.js";
import { Session } from "../identity/models/Session.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { Subscription } from "../billing/models/Subscription.js";
import { deleteUserAccount } from "../identity/account-deletion.service.js";
import { sendAdminSecurityResetEmail } from "../../infra/mail/mailer.js";
import { badRequest, notFound } from "../../shared/errors/index.js";

export const AUDIENCES = ["internal", "external"] as const;
export type Audience = (typeof AUDIENCES)[number];

export function isAudience(value: unknown): value is Audience {
  return typeof value === "string" && (AUDIENCES as readonly string[]).includes(value);
}

function notifySecurityReset(target: { email: string; name?: string | null }, subject: string, label: string) {
  sendAdminSecurityResetEmail({ email: target.email, name: target.name ?? "" }, subject).catch((e) =>
    console.error(`[admin] ${label} notice failed:`, (e as Error)?.message),
  );
}

export async function disableUserTwoFactor(userId: string, actor: string) {
  const target = await User.findById(userId);
  if (!target) throw notFound("user not found");
  if (!target.totpEnabled) throw badRequest("2fa is already off for this account");

  target.totpEnabled = false;
  target.totpSecretEnc = "";
  target.totpBackupCodeHashes = [];
  await target.save();

  console.log(`[admin] ${actor} disabled 2fa for user ${target.id} (${target.email})`);
  notifySecurityReset(target, "Two-factor authentication was turned off", "2fa-disable");
  return { id: target.id, email: target.email };
}

export async function resetUserScreenLock(userId: string, actor: string) {
  const target = await User.findById(userId);
  if (!target) throw notFound("user not found");
  if (!target.screenLockEnabled && !target.pinHash) throw badRequest("this account has no screen lock or PIN set");

  target.screenLockEnabled = false;
  target.pinHash = "";
  target.lockedAt = null;
  await target.save();

  console.log(`[admin] ${actor} reset the screen lock for user ${target.id} (${target.email})`);
  notifySecurityReset(target, "Your screen lock and PIN were reset", "screen-lock-reset");
  return { id: target.id, email: target.email };
}

export async function setUserAudience(userId: string, audience: Audience, actor: string) {
  const target = await User.findByIdAndUpdate(userId, { audience }, { new: true }).select("email audience");
  if (!target) throw notFound("user not found");

  console.log(`[admin] ${actor} marked user ${target.id} (${target.email}) as ${audience}`);
  return { id: target.id, audience };
}

export async function grantWorkspaceSiteSlot(workspaceId: string, actor: string) {
  const ws = await Workspace.findById(workspaceId).select("_id");
  if (!ws) throw notFound("workspace not found");

  const sub = await Subscription.findOneAndUpdate({ workspaceId: ws.id }, { $inc: { addonSiteSlots: 1 } }, { upsert: true, new: true });

  console.log(`[admin] ${actor} granted a site slot to workspace ${ws.id}`);
  return { workspaceId: ws.id, addonSiteSlots: Number(sub.get("addonSiteSlots") ?? 0) };
}

export const ACCOUNT_STATUSES = ["active", "suspended"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export function isAccountStatus(value: unknown): value is AccountStatus {
  return typeof value === "string" && (ACCOUNT_STATUSES as readonly string[]).includes(value);
}

export async function setUserStatus(userId: string, status: AccountStatus, reason: string, actor: string) {
  const target = await User.findById(userId).select("email role status");
  if (!target) throw notFound("user not found");
  if (status === "suspended" && (target.role === "admin" || target.role === "super_admin")) throw badRequest("cannot suspend an admin account");

  target.set({ status, statusReason: reason.slice(0, 300), statusChangedAt: new Date() });
  await target.save();
  if (status === "suspended") await Session.updateMany({ userId: target._id, revokedAt: null }, { $set: { revokedAt: new Date() } });

  console.log(`[admin] ${actor} set user ${target.id} (${target.email}) to ${status}`);
  return { id: target.id, status };
}

export async function deleteUserAsAdmin(userId: string, actor: string, requesterId?: string) {
  const target = await User.findById(userId).select("email role");
  if (!target) throw notFound("user not found");
  if (target.role === "admin" || target.role === "super_admin") throw badRequest("cannot delete an admin account");
  if (requesterId && target.id === requesterId) throw badRequest("cannot delete your own account");

  await deleteUserAccount(target.id);

  console.log(`[admin] ${actor} deleted user ${target.id} (${target.email})`);
  return { id: target.id, email: target.email };
}
