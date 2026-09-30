import { Dashboard } from "./models/Dashboard.js";
import { Embed } from "./models/Embed.js";
import { GoalTarget } from "./models/GoalTarget.js";

export async function deleteWorkspaceDashboards(workspaceId: string): Promise<void> {
  await Promise.all([
    Dashboard.deleteMany({ workspaceId }),
    Embed.deleteMany({ workspaceId }),
    GoalTarget.deleteMany({ workspaceId }),
  ]);
}
