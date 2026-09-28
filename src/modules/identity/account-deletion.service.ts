import { Workspace } from "../workspace/models/Workspace.js";
import { Site } from "../analytics/models/Site.js";
import { Event } from "../analytics/models/Event.js";
import { ApiKey } from "./models/ApiKey.js";
import { Goal } from "../analytics/models/Goal.js";
import { Project } from "../workspace/models/Project.js";
import { Subscription } from "../billing/models/Subscription.js";
import { Membership } from "../workspace/models/Membership.js";
import { WorkspaceInvite } from "../workspace/models/WorkspaceInvite.js";
import { invalidateSite } from "../billing/event-quota.js";
import { User } from "./models/User.js";

export async function deleteUserAccount(userId: string): Promise<void> {
  const workspaces = await Workspace.find({ userId }).select("_id");
  const wsIds = workspaces.map((w) => w._id);

  const sites = await Site.find({ workspaceId: { $in: wsIds } }).select("siteId");
  const siteIds = sites.map((s) => s.siteId);

  await Event.deleteMany({ siteId: { $in: siteIds } });
  await Site.deleteMany({ workspaceId: { $in: wsIds } });

  await ApiKey.deleteMany({
    $or: [{ userId }, { workspaceId: { $in: wsIds } }],
  });
  await Goal.deleteMany({ workspaceId: { $in: wsIds } });
  await Project.deleteMany({ workspaceId: { $in: wsIds } });

  await Subscription.deleteMany({ workspaceId: { $in: wsIds } });
  await Membership.deleteMany({ $or: [{ userId }, { workspaceId: { $in: wsIds } }] });
  await WorkspaceInvite.deleteMany({ workspaceId: { $in: wsIds } });
  await Workspace.deleteMany({ userId });
  await User.deleteOne({ _id: userId });

  for (const id of siteIds) invalidateSite(id as string);
}
