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

export function findWorkspaceConnection(workspaceId: unknown, provider: Provider) {
  return SocialConnection.findOne({ workspaceId, provider });
}

export async function connectionTakenElsewhere(
  provider: Provider,
  providerUserId: string,
  workspaceId: string,
): Promise<boolean> {
  const found = await SocialConnection.findOne({
    provider,
    providerUserId,
    workspaceId: { $ne: workspaceId },
  }).select("_id").lean();
  return Boolean(found);
}
