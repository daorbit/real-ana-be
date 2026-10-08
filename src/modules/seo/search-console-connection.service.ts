import { SearchConsoleConnection } from "./models/SearchConsoleConnection.js";
import { SearchConsoleProperty } from "./models/SearchConsoleProperty.js";
import { SearchConsoleCache } from "./models/SearchConsoleCache.js";
import { revokeSearchConsoleToken } from "../../infra/http-client/search-console.js";
import { decryptSecret } from "../../shared/utils/crypto-box.js";

export async function disconnectSearchConsole(workspaceId: string): Promise<void> {
  const connection = await SearchConsoleConnection.findOne({ workspaceId }).select("+refreshToken");
  const refreshToken = connection ? decryptSecret(String(connection.get("refreshToken") ?? "")) : "";
  if (refreshToken) await revokeSearchConsoleToken(refreshToken);

  await Promise.all([
    SearchConsoleCache.deleteMany({ workspaceId }),
    SearchConsoleProperty.deleteMany({ workspaceId }),
    SearchConsoleConnection.deleteOne({ workspaceId }),
  ]);
}
