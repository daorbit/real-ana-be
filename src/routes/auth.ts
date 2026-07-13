import { Router, Response } from "express";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { signToken, requireAuth, AuthedRequest } from "../auth.js";

const router = Router();

router.post("/signup", async (req, res) => {
  try {
    const { email, password, name } = req.body ?? {};
    if (!email || !password || !name)
      return res.status(400).json({ error: "email, password, name required" });
    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ error: "email already registered" });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, passwordHash, name });
    const token = signToken(user.id);
    res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name } });
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
    if (!user) {
      if (process.env.NODE_ENV !== "production")
        console.log(`[login] no user row for ${email.toLowerCase()}`);
      return res.status(401).json({ error: "invalid credentials" });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      if (process.env.NODE_ENV !== "production")
        console.log(`[login] password mismatch for ${user.email}`);
      return res.status(401).json({ error: "invalid credentials" });
    }
    const token = signToken(user.id);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch {
    res.status(500).json({ error: "login failed" });
  }
});

router.get("/me", requireAuth, async (req: AuthedRequest, res: Response) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: "not found" });
  res.json({ id: user.id, email: user.email, name: user.name });
});

export default router;
