import { GoogleConnection } from "./models/GoogleConnection.js";
import { GoogleLocation } from "./models/GoogleLocation.js";
import { GoogleReview } from "./models/GoogleReview.js";
import { revokeToken } from "../../infra/http-client/google-business.js";
import { decryptSecret } from "../../shared/utils/crypto-box.js";

export async function disconnectGoogleReviews(workspaceId: string): Promise<void> {
  const stored = await GoogleConnection.findOne({ workspaceId }).select("+refreshToken");
  const refreshToken = stored ? decryptSecret(String(stored.get("refreshToken") ?? "")) : "";
  if (refreshToken) await revokeToken(refreshToken);

  await Promise.all([
    GoogleReview.deleteMany({ workspaceId }),
    GoogleLocation.deleteMany({ workspaceId }),
    GoogleConnection.deleteOne({ workspaceId }),
  ]);
}
