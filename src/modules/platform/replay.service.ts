import { PlatformTokenUse } from "./models/PlatformTokenUse.js";

export async function claimPlatformToken(jti: string, expiresAt: Date): Promise<boolean> {
  try {
    await PlatformTokenUse.create({ jti, expiresAt });
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return false;
    throw error;
  }
}
