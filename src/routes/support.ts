import { Router, Response } from "express";
import { ContactMessage } from "../models/ContactMessage.js";
import { User } from "../models/User.js";
import { requireAuth, AuthedRequest } from "../auth.js";
import { clientIp } from "../enrich.js";
import { mailConfigured, sendOne, contactAckHtml, contactAckText } from "../lib/mail.js";
import crypto from "crypto";

/**
 * Support requests raised from inside the dashboard.
 *
 * The same inbox as the marketing site's contact form, deliberately: a bug
 * report and a sales enquiry both need someone to read and answer them, and
 * splitting them across two systems is how one of them stops being read.
 *
 * What differs is trust. The sender here is authenticated, so their name and
 * address come from the account rather than from the request body — a signed-in
 * user cannot file a report under someone else's address, and nobody has to
 * retype what we already know.
 */
const router = Router();
router.use(requireAuth);

/** Kinds a user can raise from the app. Narrower than the marketing form. */
const KINDS = ["support", "bug", "feedback"] as const;
type Kind = (typeof KINDS)[number];

const KIND_LABELS: Record<Kind, string> = {
  support: "Help with my account",
  bug: "Bug report",
  feedback: "Product feedback",
};

/** Messages allowed from one account per window, before we start refusing. */
const RATE_LIMIT = 10;
const WINDOW_MS = 60 * 60 * 1000;

function hashIp(ip: string): string {
  const secret = process.env.JWT_SECRET ?? "";
  return crypto.createHmac("sha256", secret).update(ip).digest("hex").slice(0, 32);
}

router.post("/", async (req: AuthedRequest, res: Response) => {
  const user = await User.findById(req.userId).select("email name firstName lastName");
  if (!user) return res.status(401).json({ error: "account not found" });

  const rawKind = String(req.body?.kind ?? "").trim();
  const kind: Kind = KINDS.includes(rawKind as Kind) ? (rawKind as Kind) : "support";
  const message = String(req.body?.message ?? "").trim().slice(0, 5000);
  const pageUrl = String(req.body?.pageUrl ?? "").trim().slice(0, 500);

  if (message.length < 10) {
    return res.status(400).json({ error: "Please add a little more detail" });
  }

  const since = new Date(Date.now() - WINDOW_MS);
  const recent = await ContactMessage.countDocuments({
    userId: user._id,
    createdAt: { $gt: since },
  });
  if (recent >= RATE_LIMIT) {
    return res
      .status(429)
      .json({ error: "You've sent a lot of messages recently. Try again in a little while." });
  }

  const name =
    user.name || [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;

  const saved = await ContactMessage.create({
    name,
    email: user.email,
    subject: kind,
    message,
    pageUrl,
    source: "app",
    userId: user._id,
    ipHash: hashIp(clientIp(req)),
    userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300),
  });

  // Same receipt the marketing form sends. Not awaited into the response: the
  // report is already stored, and a mail outage must not read to the user as a
  // failed submission they should repeat.
  if (mailConfigured()) {
    const label = KIND_LABELS[kind];
    sendOne(
      { email: user.email, name },
      "We got your message — Quantalog",
      contactAckText(name, label, message),
      contactAckHtml(name, label, message)
    ).then(
      () => ContactMessage.updateOne({ _id: saved._id }, { ackSentAt: new Date() }).exec(),
      (e) => console.error("[support] acknowledgement failed:", (e as Error)?.message)
    );
  }

  res.status(201).json({ ok: true });
});

export default router;
