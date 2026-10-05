import { User } from "./models/User.js";
import { mailConfigured, sendWelcomeEmail } from "../../infra/mail/mailer.js";
import type { GoogleProfile } from "../../infra/http-client/google-auth.js";

export async function resolveGoogleUser(profile: GoogleProfile) {
  let user = await User.findOne({ email: profile.email });

  if (!user) {
    const [firstName, ...rest] = profile.name.split(" ");
    user = await User.create({
      email: profile.email,
      name: profile.name,
      firstName: firstName ?? "",
      lastName: rest.join(" "),
      googleId: profile.sub,
      avatarUrl: profile.picture,
    });

    if (mailConfigured()) {
      const { email, name } = user;
      void sendWelcomeEmail({ email, name }).catch((e: unknown) => {
        console.error("[google] welcome email failed:", e instanceof Error ? e.message : e);
      });
    }

    return { user, created: true };
  }

  if (!user.googleId) {
    user.googleId = profile.sub;
    if (!user.avatarUrl) user.avatarUrl = profile.picture;
    await user.save();
  }

  return { user, created: false };
}
