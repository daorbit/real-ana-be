import { Router, Request, Response } from "express";
import crypto from "crypto";
import { ContactMessage } from "../models/ContactMessage.js";
import { clientIp } from "../enrich.js";
import { mailConfigured, sendOne, newsletterAckHtml, newsletterAckText } from "../lib/mail.js";

/**
 * Newsletter signups from the marketing site.
 *
 * Separate from the contact form because the shape is different: an address and
 * nothing else. The contact endpoint requires a name and a ten-character
 * message, and relaxing those to accommodate a one-field form would weaken the
 * checks on the form that actually needs them.
 *
 * The rows land in the same collection, and so the same admin inbox. A
 * subscriber list and a support queue are both "people who want something from
 * us", and one screen that shows both is one screen someone actually reads.
 *
 * Unauthenticated and therefore entirely attacker-controlled: the address is
 * length-capped, the rate limit is per-IP, and nothing here is ever rendered as
 * HTML.
 */
const router = Router();

/** Signups allowed from one caller per window. Lower than the contact form —
 *  there is no legitimate reason to subscribe five times in an hour. */
const RATE_LIMIT = 3;
const WINDOW_MS = 60 * 60 * 1000;

function hashIp(ip: string): string {
  const secret = process.env.JWT_SECRET ?? "";
  return crypto.createHmac("sha256", secret).update(ip).digest("hex").slice(0, 32);
}

function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

router.post("/", async (req: Request, res: Response) => {
  const email = str(req.body?.email, 200).toLowerCase();
  const pageUrl = str(req.body?.pageUrl, 500);

  // Same honeypot as the contact form: a hidden field no human fills in.
  // Answered with the success shape, because telling a bot it was caught only
  // teaches it to stop filling the field.
  if (str(req.body?.website, 100)) {
    return res.status(202).json({ ok: true });
  }

  if (!email) return res.status(400).json({ error: "An email address is required" });
  if (!looksLikeEmail(email)) {
    return res.status(400).json({ error: "That email address does not look valid" });
  }

  const ipHash = hashIp(clientIp(req));
  const since = new Date(Date.now() - WINDOW_MS);
  const recent = await ContactMessage.countDocuments({
    ipHash,
    source: "newsletter",
    createdAt: { $gt: since },
  });

  if (recent >= RATE_LIMIT) {
    return res
      .status(429)
      .json({ error: "Too many signups from here. Try again in a little while." });
  }

  // Subscribing twice is a normal thing to do — a second device, a forgotten
  // first attempt — and it is not an error worth showing. Report success
  // without writing a duplicate row, so the inbox stays one-row-per-person.
  const existing = await ContactMessage.findOne({ email, source: "newsletter" }).select("_id");
  if (existing) {
    return res.status(200).json({ ok: true, already: true });
  }

  const saved = await ContactMessage.create({
    // The schema wants a name and a message; a newsletter signup has neither.
    // Deriving the name from the address beats an empty cell in the inbox, and
    // the message says what the row is for.
    name: email.split("@")[0],
    email,
    subject: "newsletter",
    message: "Subscribed to the newsletter from the marketing site.",
    pageUrl,
    source: "newsletter",
    ipHash,
    userAgent: str(req.headers["user-agent"], 300),
  });

  // Confirm the subscription. Not awaited into the response: the address is
  // already stored, and a mail outage must not read to the visitor as a failed
  // signup they should repeat.
  if (mailConfigured()) {
    sendOne(
      { email },
      "You're subscribed — Quantalog",
      newsletterAckText(),
      newsletterAckHtml(),
      [],
      // Mail to someone with no account needs a one-click way out, or it is
      // indistinguishable from spam to both the recipient and their provider.
      { "List-Unsubscribe": `<mailto:${process.env.SMTP_USER ?? ""}?subject=unsubscribe>` }
    ).then(
      () => ContactMessage.updateOne({ _id: saved._id }, { ackSentAt: new Date() }).exec(),
      (e) => console.error("[newsletter] confirmation failed:", (e as Error)?.message)
    );
  }

  res.status(201).json({ ok: true });
});

export default router;
