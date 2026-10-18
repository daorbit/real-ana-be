import { SearchConsoleConnection } from "./models/SearchConsoleConnection.js";
import { SearchConsoleProperty } from "./models/SearchConsoleProperty.js";
import { SearchConsoleCache } from "./models/SearchConsoleCache.js";

export async function disconnectSearchConsole(workspaceId: string): Promise<void> {
  await Promise.all([
    SearchConsoleCache.deleteMany({ workspaceId }),
    SearchConsoleProperty.deleteMany({ workspaceId }),
    SearchConsoleConnection.deleteOne({ workspaceId }),
  ]);
}
