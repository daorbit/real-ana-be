import { Router, Request, Response } from "express";
import { ReportSchedule } from "../models/ReportSchedule.js";
import { renderScheduleHtml } from "../lib/report-runner.js";

/**
 * Unsubscribing from a scheduled report.
 *
 * Unauthenticated by design, exactly like the public share links: the token in
 * the URL is the entire credential. Most people on a report's recipient list
 * have no account, so requiring a login to stop receiving mail would mean
 * requiring them to sign up for a product they never asked for — which is how
 * a report becomes a spam complaint.
 *
 * Returns HTML rather than JSON: the caller is a browser that just followed a
 * link out of an email client, and a page of raw JSON reads as an error even
 * when it says `"ok": true`.
 */
const router = Router();

function page(title: string, message: string, tone: "ok" | "error" = "ok"): string {
  const accent = tone === "ok" ? "#10b981" : "#f87171";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Quantalog</title></head>
<body style="margin:0;background:#0b0c0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:440px;margin:14vh auto;padding:32px;background:#131519;border:1px solid #22252c;border-radius:16px;text-align:center">
    <div style="font-size:20px;font-weight:700;color:#f3f4f6;margin-bottom:10px">Quantalog<span style="color:${accent}">.</span></div>
    <div style="font-size:17px;font-weight:600;color:#f3f4f6;margin-bottom:8px">${title}</div>
    <p style="margin:0;font-size:14px;color:#9ca3af;line-height:1.6">${message}</p>
  </div>
</body></html>`;
}

/**
 * `GET` and `POST` both work.
 *
 * `GET` is the link a person clicks. `POST` is what Gmail and Outlook send
 * behind their own one-click unsubscribe button, from the `List-Unsubscribe`
 * header — if that POST 404s, the mail client concludes unsubscribing is
 * broken and starts treating the sender accordingly.
 */
async function unsubscribe(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token ?? "");

  const schedule = await ReportSchedule.findOne({ "recipients.unsubToken": token });
  if (!schedule) {
    // Deliberately vague: a token that has already been used and a token that
    // was never real get the same answer, so this endpoint can't be used to
    // test whether an address is on a list.
    res.status(404).send(page("Link not found", "This unsubscribe link is no longer valid. You may have already been removed.", "error"));
    return;
  }

  const recipients = schedule.get("recipients") as { email: string; unsubToken: string; unsubscribedAt?: Date }[];
  const match = recipients.find((r) => r.unsubToken === token);
  if (!match) {
    res.status(404).send(page("Link not found", "This unsubscribe link is no longer valid.", "error"));
    return;
  }

  if (!match.unsubscribedAt) {
    match.unsubscribedAt = new Date();
    schedule.markModified("recipients");
    await schedule.save();
  }

  res.send(
    page(
      "Unsubscribed",
      `<strong style="color:#f3f4f6">${escapeHtml(match.email)}</strong> will no longer receive the “${escapeHtml(
        schedule.get("name") as string
      )}” report.<br><br>This only affects this one report. If someone shares another report with you, you'll still receive that.`
    )
  );
}

/**
 * The hosted view of a report.
 *
 * Unauthenticated, like the unsubscribe route above and for the same reason:
 * the recipient is someone the owner shared with, not an account holder. The
 * token in the URL is the whole credential, so it is long, random, and its own
 * — revoking a report link must not touch the workspace's dashboard link.
 *
 * Figures are recomputed per request rather than frozen at send time. A link
 * that keeps working but shows last month's numbers is worse than one that
 * expired, because nothing about it looks wrong.
 */
router.get("/view/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token ?? "");
  // Cheap shape check before a database round trip, so a flood of junk tokens
  // costs nothing — same reasoning as the workspace share route.
  if (!token.startsWith("rp_") || token.length > 64) {
    res.status(404).send(page("Report not found", "This report link is not valid.", "error"));
    return;
  }

  const schedule = await ReportSchedule.findOne({ viewToken: token });
  if (!schedule) {
    res.status(404).send(page("Report not found", "This report link is no longer valid.", "error"));
    return;
  }

  try {
    const html = await renderScheduleHtml(schedule);
    // Briefly cacheable: a recipient refreshing the same page shouldn't
    // recompute a full analytics aggregation each time.
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("html").send(html);
  } catch (e) {
    res.status(500).send(page("Report unavailable", `This report could not be generated: ${escapeHtml((e as Error).message)}`, "error"));
  }
});

router.get("/unsubscribe/:token", unsubscribe);
router.post("/unsubscribe/:token", unsubscribe);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

export default router;
