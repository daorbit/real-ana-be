import { Router, Response } from "express";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { signToken, requireAuth, AuthedRequest } from "../auth.js";

const router = Router();

/** The shape every auth response returns — one place, so they can't drift. */
function publicUser(user: InstanceType<typeof User>) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    // Accounts predating the name split have only `name`. Falling back to it
    // means the settings form opens populated instead of blank.
    firstName: user.firstName || user.name.split(" ")[0] || "",
    lastName: user.lastName || user.name.split(" ").slice(1).join(" "),
    mobile: user.mobile ?? "",
    avatarUrl: user.avatarUrl ?? "",
    dateLocale: user.dateLocale ?? "",
    timezone: user.timezone ?? "",
    role: user.role,
  };
}

router.post("/signup", async (req, res) => {
  try {
    const { email, password, name } = req.body ?? {};
    if (!email || !password || !name)
      return res.status(400).json({ error: "email, password, name required" });
    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ error: "email already registered" });
    const passwordHash = await bcrypt.hash(password, 10);
    // `role` is deliberately not read from the body — a signup cannot ask to be
    // an admin. The schema default makes every new account a plain user.
    // Signup collects one name field; split it so the settings form opens with
    // the parts already filled rather than making everyone retype them.
    const parts = String(name).trim().split(/\s+/);
    const user = await User.create({
      email,
      passwordHash,
      name,
      firstName: parts[0] ?? "",
      lastName: parts.slice(1).join(" "),
    });
    const token = signToken(user.id);
    res.status(201).json({ token, user: publicUser(user) });
  } catch {
    res.status(500).json({ error: "signup failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password)
      return res.status(400).json({ error: "email, password required" });
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: "invalid credentials" });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "invalid credentials" });
    const token = signToken(user.id);
    res.json({ token, user: publicUser(user) });
  } catch {
    res.status(500).json({ error: "login failed" });
  }
});

router.get("/me", requireAuth, async (req: AuthedRequest, res: Response) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: "not found" });
  res.json({
    ...publicUser(user),
    // Survives a refresh, so the "you are viewing as …" banner can come back.
    impersonating: Boolean(req.impersonatorId),
  });
});

/**
 * Update the signed-in user's profile.
 *
 * Email and role are deliberately not editable here: email is the login
 * identity (changing it needs a verification flow) and role is granted, never
 * requested. Everything else is optional — an omitted field is left alone,
 * which is what lets the form send only what changed.
 */
router.patch("/me", requireAuth, async (req: AuthedRequest, res: Response) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: "not found" });

  const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  const body = req.body ?? {};

  if (body.firstName !== undefined) user.firstName = str(body.firstName, 60);
  if (body.lastName !== undefined) user.lastName = str(body.lastName, 60);
  if (body.mobile !== undefined) user.mobile = str(body.mobile, 30);
  if (body.avatarUrl !== undefined) {
    const url = str(body.avatarUrl, 500);
    // Anything that isn't an http(s) URL ends up in an <img src>, where a
    // javascript: or data: value is a scripting vector rather than a picture.
    if (url && !/^https?:\/\//i.test(url))
      return res.status(400).json({ error: "avatarUrl must be an http(s) URL" });
    user.avatarUrl = url;
  }
  if (body.dateLocale !== undefined) user.dateLocale = str(body.dateLocale, 35);
  if (body.timezone !== undefined) user.timezone = str(body.timezone, 64);

  // `name` is what the rest of the app reads, so keep it in step. An account
  // that clears both parts keeps its old display name rather than becoming
  // nameless — the field is required.
  const composed = `${user.firstName} ${user.lastName}`.trim();
  if (composed) user.name = composed;

  await user.save();
  res.json(publicUser(user));
});

export default router;
