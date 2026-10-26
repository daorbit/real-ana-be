import { Types } from "mongoose";
import { SocialConnection, Provider } from "../identity/models/SocialConnection.js";
import { resolveAccessFor, isDenied } from "../workspace/access.service.js";
import { WorkspaceRole } from "../workspace/models/Membership.js";
import { badRequest, notFound } from "../../shared/errors/index.js";

export const SOCIAL_CONNECT_ROLE: WorkspaceRole = "editor";

export function readWorkspaceId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!/^[a-f0-9]{24}$/i.test(id)) throw badRequest("workspaceId is required");
  return id;
}

export async function assertSocialAccess(
  userId: string | undefined,
  workspaceId: string,
  minimum: WorkspaceRole = "viewer",
): Promise<void> {
  const access = await resolveAccessFor(userId, workspaceId, minimum);
  if (isDenied(access)) throw notFound(access.error);
}

export async function canManageSocial(userId: string, workspaceId: string): Promise<boolean> {
  const access = await resolveAccessFor(userId, workspaceId, SOCIAL_CONNECT_ROLE);
  return !isDenied(access);
}

const LEGACY_USER_INDEX = "userId_1_provider_1";

function hitsLegacyIndex(e: unknown): boolean {
  const err = e as { code?: number; message?: string };
  return err?.code === 11000 && String(err.message ?? "").includes(LEGACY_USER_INDEX);
}

export async function saveWorkspaceConnection(
  workspaceId: string,
  provider: Provider,
  fields: Record<string, unknown>,
): Promise<void> {
  const write = () =>
    SocialConnection.findOneAndUpdate(
      { workspaceId: new Types.ObjectId(workspaceId), provider },
      { $set: fields },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

  try {
    await write();
  } catch (e) {
    if (!hitsLegacyIndex(e)) throw e;
    await SocialConnection.collection.dropIndex(LEGACY_USER_INDEX).catch(() => {});
    await write();
  }
}

export function findWorkspaceConnection(workspaceId: string | Types.ObjectId, provider: Provider) {
  return SocialConnection.findOne({ workspaceId: new Types.ObjectId(String(workspaceId)), provider });
}

export function deleteWorkspaceConnection(workspaceId: string, provider: Provider) {
  return SocialConnection.findOneAndDelete({ workspaceId: new Types.ObjectId(workspaceId), provider });
}

export async function connectionTakenElsewhere(
  provider: Provider,
  providerUserId: string,
  workspaceId: string,
): Promise<boolean> {
  const found = await SocialConnection.findOne({
    provider,
    providerUserId,
    workspaceId: { $ne: new Types.ObjectId(workspaceId) },
  }).select("_id").lean();
  return Boolean(found);
}
