import { Router, Request, Response } from "express";
import crypto from "crypto";
import { ContactMessage } from "../models/ContactMessage.js";
import { clientIp } from "../enrich.js";

/**
 * The contact form on the marketing site.
 *
 * Unauthenticated by design — someone who has not signed up still needs a way
 * to reach us, and requiring an account first is how an enquiry becomes a lost
 * customer. That means every field here is attacker-controlled: nothing is
 * trusted, everything is length-capped, and none of it is ever rendered as
 * HTML anywhere.
 *
 * Reading these back is a separate, admin-only surface (see routes/admin.ts).
 * This router only ever writes.
 */
const router = Router();

/** Messages allowed from one caller per window, before we start refusing. */
const RATE_LIMIT = 5;
const WINDOW_MS = 60 * 60 * 1000;

const SUBJECTS = ["general", "sales", "support", "platform-api", "privacy", "other"] as const;
type Subject = (typeof SUBJECTS)[number];

/**
 * Key the hash with the server secret so a leaked database cannot be walked
 * back to addresses by hashing candidate IPs — an unkeyed digest of a value
 * from a space this small is trivially reversible.
 */
function hashIp(ip: string): string {
  const secret = process.env.JWT_SECRET ?? "";
  return crypto.createHmac("sha256", secret).update(ip).digest("hex").slice(0, 32);
}

/** Deliberately permissive: the only thing worth rejecting here is a value that
 *  cannot possibly be an address, because a false negative loses a real message. */
function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

router.post("/", async (req: Request, res: Response) => {
  const name = str(req.body?.name, 120);
  const email = str(req.body?.email, 200).toLowerCase();
  const company = str(req.body?.company, 160);
  const message = str(req.body?.message, 5000);
  const pageUrl = str(req.body?.pageUrl, 500);
  const rawSubject = str(req.body?.subject, 40);
  const subject: Subject = SUBJECTS.includes(rawSubject as Subject)
    ? (rawSubject as Subject)
    : "general";

  // A hidden field no human ever fills in. Bots complete every input they find,
  // so a non-empty value is a bot — answered with the same success shape it
  // would get otherwise, because telling a bot it was caught only teaches it.
  if (str(req.body?.website, 100)) {
    return res.status(202).json({ ok: true });
  }

  if (!name || !email || !message) {
    return res.status(400).json({ error: "Name, email and message are required" });
  }
  if (!looksLikeEmail(email)) {
    return res.status(400).json({ error: "That email address does not look valid" });
  }
  if (message.length < 10) {
    return res.status(400).json({ error: "Please add a little more detail" });
  }

  const ipHash = hashIp(clientIp(req));
  const since = new Date(Date.now() - WINDOW_MS);
  const recent = await ContactMessage.countDocuments({ ipHash, createdAt: { $gt: since } });

  if (recent >= RATE_LIMIT) {
    return res
      .status(429)
      .json({ error: "Too many messages from here. Try again in a little while." });
  }

  await ContactMessage.create({
    name,
    email,
    company,
    subject,
    message,
    pageUrl,
    ipHash,
    userAgent: str(req.headers["user-agent"], 300),
  });

  res.status(201).json({ ok: true });
});

export default router;
