import { Types } from "mongoose";
import { OAuthGrant } from "./models/OAuthGrant.js";
import { OAuthToken } from "./models/OAuthToken.js";
import { OAuthCode } from "./models/OAuthCode.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { describeScopes, isScope } from "./scopes.js";

export async function revokeGrant(grantId: Types.ObjectId | string, reason: string): Promise<void> {
  await Promise.all([
    OAuthGrant.updateOne({ _id: grantId, revokedAt: null }, { revokedAt: new Date(), revokedReason: reason }),
    OAuthToken.deleteMany({ grantId }),
    OAuthCode.deleteMany({ grantId }),
  ]);
}

export async function listUserGrants(userId: string) {
  const grants = await OAuthGrant.find({ userId, revokedAt: null, activatedAt: { $ne: null } })
    .sort({ activatedAt: -1 })
    .limit(100)
    .select("workspaceId clientName scopes activatedAt lastUsedAt")
    .lean();

  const workspaceIds = [...new Set(grants.map((g) => String(g.workspaceId)))];
  const workspaces = workspaceIds.length
    ? await Workspace.find({ _id: { $in: workspaceIds } }).select("name").lean()
    : [];
  const nameById = new Map(workspaces.map((w) => [String(w._id), w.name as string]));

  return grants.map((g) => ({
    id: String(g._id),
    clientName: g.clientName,
    workspaceId: String(g.workspaceId),
    workspaceName: nameById.get(String(g.workspaceId)) ?? "",
    scopes: describeScopes(g.scopes.filter(isScope)),
    connectedAt: g.activatedAt,
    lastUsedAt: g.lastUsedAt,
  }));
}

export async function revokeUserGrant(userId: string, grantId: string) {
  if (!Types.ObjectId.isValid(grantId)) return null;
  const grant = await OAuthGrant.findOne({ _id: grantId, userId, revokedAt: null })
    .select("workspaceId clientName")
    .lean();
  if (!grant) return null;
  await revokeGrant(grant._id, "revoked_by_user");
  return { workspaceId: String(grant.workspaceId), clientName: grant.clientName };
}

const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export function touchGrant(grantId: string): void {
  void OAuthGrant.updateOne(
    {
      _id: grantId,
      $or: [{ lastUsedAt: null }, { lastUsedAt: { $lt: new Date(Date.now() - LAST_USED_THROTTLE_MS) } }],
    },
    { lastUsedAt: new Date() },
  ).catch(() => {});
}

export async function purgeGrantsFor(
  filter: { userId: string } | { workspaceId: { $in: string[] } },
): Promise<void> {
  const grants = await OAuthGrant.find(filter).select("_id").lean();
  if (!grants.length) return;
  const grantIds = grants.map((g) => g._id);
  await Promise.all([
    OAuthToken.deleteMany({ grantId: { $in: grantIds } }),
    OAuthCode.deleteMany({ grantId: { $in: grantIds } }),
    OAuthGrant.deleteMany({ _id: { $in: grantIds } }),
  ]);
}
