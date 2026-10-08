import { Workspace } from "../workspace/models/Workspace.js";
import { Membership } from "../workspace/models/Membership.js";
import { ApiKey } from "./models/ApiKey.js";
import { User } from "./models/User.js";
import { Session } from "./models/Session.js";
import { PasswordReset } from "./models/PasswordReset.js";
import { SocialConnection } from "./models/SocialConnection.js";
import { ReferralCode } from "../referrals/models/ReferralCode.js";
import { Referral } from "../referrals/models/Referral.js";
import { Coupon } from "../billing/models/Coupon.js";
import { Note } from "../notes/models/Note.js";
import { Notification } from "../notifications/models/Notification.js";
import { NotificationPref } from "../notifications/models/NotificationPref.js";
import { PushSubscription } from "../notifications/models/PushSubscription.js";
import { ScheduledPost } from "../social/models/ScheduledPost.js";
import { SocialPostRun } from "../social/models/SocialPostRun.js";
import { OrbitConversation } from "../orbit-history/models/OrbitConversation.js";
import { OrbitMessage } from "../orbit-history/models/OrbitMessage.js";
import { GoogleConnection } from "../reviews/models/GoogleConnection.js";
import { SearchConsoleConnection } from "../seo/models/SearchConsoleConnection.js";
import { disconnectGoogleReviews } from "../reviews/connection.service.js";
import { disconnectSearchConsole } from "../seo/search-console-connection.service.js";
import { purgeWorkspaces } from "../workspace/purge.service.js";
import { revokeLinkedInToken } from "../../infra/http-client/linkedin-auth.js";
import { deleteImage } from "../../infra/storage/cloudinary.js";
import { decryptSecret } from "../../shared/utils/crypto-box.js";

async function ownedWorkspaceIds(userId: string): Promise<string[]> {
  const [owned, created] = await Promise.all([
    Membership.find({ userId, role: "owner" }).select("workspaceId").lean(),
    Workspace.find({ userId }).select("_id").lean(),
  ]);
  return [
    ...new Set([
      ...owned.map((m) => String(m.workspaceId)),
      ...created.map((w) => String(w._id)),
    ]),
  ];
}

async function revokePersonalGrants(userId: string): Promise<void> {
  const [googleConnections, searchConnections, social] = await Promise.all([
    GoogleConnection.find({ userId }).select("workspaceId").lean(),
    SearchConsoleConnection.find({ userId }).select("workspaceId").lean(),
    SocialConnection.find({ userId, provider: "linkedin" }).select("+accessToken").lean(),
  ]);

  await Promise.all([
    ...googleConnections.map((c) => disconnectGoogleReviews(String(c.workspaceId))),
    ...searchConnections.map((c) => disconnectSearchConsole(String(c.workspaceId))),
    ...social.map((c) => {
      const token = decryptSecret(String(c.accessToken ?? ""));
      return token ? revokeLinkedInToken(token) : null;
    }),
  ]);
}

export async function deleteUserAccount(userId: string): Promise<{ workspacesDeleted: number }> {
  const [user, workspaceIds, conversations] = await Promise.all([
    User.findById(userId).select("avatarPublicId").lean(),
    ownedWorkspaceIds(userId),
    OrbitConversation.find({ userId }).select("_id").lean(),
  ]);

  await purgeWorkspaces(workspaceIds);
  await revokePersonalGrants(userId);

  await Promise.all([
    Membership.deleteMany({ userId }),
    Session.deleteMany({ userId }),
    PasswordReset.deleteMany({ userId }),
    ApiKey.deleteMany({ userId }),
    SocialConnection.deleteMany({ userId }),
    ScheduledPost.deleteMany({ userId }),
    SocialPostRun.deleteMany({ userId }),
    Note.deleteMany({ userId }),
    Notification.deleteMany({ userId }),
    NotificationPref.deleteMany({ userId }),
    PushSubscription.deleteMany({ userId }),
    OrbitMessage.deleteMany({ conversationId: { $in: conversations.map((c) => c._id) } }),
    OrbitConversation.deleteMany({ userId }),
    ReferralCode.deleteMany({ userId }),
    Referral.deleteMany({ $or: [{ referrerId: userId }, { refereeId: userId }] }),
    Coupon.deleteMany({ ownerId: userId }),
  ]);

  if (user?.avatarPublicId) await deleteImage(String(user.avatarPublicId));
  await User.deleteOne({ _id: userId });
  return { workspacesDeleted: workspaceIds.length };
}
