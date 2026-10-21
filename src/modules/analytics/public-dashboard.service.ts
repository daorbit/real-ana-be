import { nanoid } from "nanoid";
import { Workspace } from "../workspace/models/Workspace.js";

export function newShareToken(): string {
  return `pk_${nanoid(32)}`;
}

export async function syncPublicDashboard(workspaceId: string, enabled: boolean): Promise<void> {
  if (!enabled) {
    await Workspace.updateOne({ _id: workspaceId }, { $set: { shareEnabled: false } });
    return;
  }
  await Workspace.updateOne(
    { _id: workspaceId, shareToken: { $in: [null, ""] } },
    { $set: { shareToken: newShareToken() } },
  );
  await Workspace.updateOne({ _id: workspaceId }, { $set: { shareEnabled: true } });
}
