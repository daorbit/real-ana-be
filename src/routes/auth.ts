import { Router, Response } from "express";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { signToken, signDemoToken, requireAuth, blockDemoWrites, AuthedRequest } from "../auth.js";
import { ensureDemoUser } from "../lib/demo-seed.js";

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

/**
 * Signup validation.
 *
 * The client validates the same rules for fast feedback, but this is the copy
 * that counts — the API is reachable directly, so anything enforced only in
 * the browser is not enforced at all.
 */
function signupError(body: {
  email?: unknown;
  password?: unknown;
  name?: unknown;
}): string | null {
  const email = String(body.email ?? "").trim();
  const password = String(body.password ?? "");
  const name = String(body.name ?? "").trim();

  if (!email || !password || !name)
    return "email, password, name required";

  // Deliberately permissive: the only authority on a valid address is a
  // delivered email. This rejects the obviously malformed, nothing more.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254)
    return "enter a valid email address";

  if (name.length < 2) return "name must be at least 2 characters";
  if (name.length > 60) return "name must be 60 characters or fewer";

  if (password.length < 8)
    return "password must be at least 8 characters";
  // bcrypt silently truncates at 72 bytes, so a longer password would give a
  // false sense of strength.
  if (password.length > 72)
    return "password must be 72 characters or fewer";
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
    return "password must contain at least one letter and one number";

  return null;
}

router.post("/signup", async (req, res) => {
  try {
    const { email, password, name } = req.body ?? {};

    const invalid = signupError(req.body ?? {});
    if (invalid) return res.status(400).json({ error: invalid });

    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ error: "email already registered" });
    const passwordHash = await bcrypt.hash(password, 10);
    // `role` is deliberately not read from the body — a signup cannot ask to be
    // an admin. The schema default makes every new account a plain user.
    // Signup collects one name field; split it so the settings form opens with
    // the parts already filled rather than making everyone retype them.
    const cleanName = String(name).trim();
    const parts = cleanName.split(/\s+/);
    const user = await User.create({
      email: String(email).trim(),
      passwordHash,
      name: cleanName,
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
    // Lets the client switch to its read-only demo behaviour after a reload.
    demo: Boolean(req.isDemo),
  });
});


router.post("/demo", async (_req, res) => {
  try {
    const userId = await ensureDemoUser();
    const user = await User.findById(userId);
    if (!user) return res.status(500).json({ error: "demo unavailable" });
    const token = signDemoToken(userId);
    res.json({ token, user: { ...publicUser(user), demo: true } });
  } catch {
    res.status(500).json({ error: "could not start demo" });
  }
});

/**
 * Update the signed-in user's profile.
 *
 * Email and role are deliberately not editable here: email is the login
 * identity (changing it needs a verification flow) and role is granted, never
 * requested. Everything else is optional — an omitted field is left alone,
 * which is what lets the form send only what changed.
 */
router.patch("/me", requireAuth, blockDemoWrites, async (req: AuthedRequest, res: Response) => {
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
