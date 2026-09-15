/**
 * The two routes that put a model behind the social composer.
 *
 * Split out of `workspaces.ts`, which had grown to 1,400 lines by absorbing
 * every route that happened to hang off a workspace id. These two have nothing
 * to do with the rest of that file: they own the prompts, the model choice and
 * the timeouts for the composer, and those are edited together and for reasons
 * that never touch sites, membership or stats.
 *
 * Mounted under the same `/api/workspaces` prefix, so the URLs are unchanged.
 */

import { Router, Response } from "express";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { resolveAccess, isDenied } from "../../modules/workspace/access.service.js";
import { Site } from "../../modules/analytics/models/Site.js";
import { computeStats, resolveWindow } from "../../modules/analytics/stats.service.js";
import { askOrbit, orbitConfigured } from "../../modules/orbit/index.js";
import { quantalogOrbitHost, effectiveOrbitPlan } from "../../modules/orbit/orbit-host.js";
import { parsePlan } from "../../modules/social/plan-parse.js";
import { readSeoPanels } from "./seo.js";
import { cloudinaryConfigured, uploadImage } from "../../infra/storage/cloudinary.js";
import { resolveBranding } from "../../modules/branding/branding.service.js";
import { watermarkTransformation } from "./orbit.js";
import { planLimit } from "../plan-limit.js";

const router = Router();
router.use(requireAuth);
// A demo session may read every workspace route but write none.
router.use(blockDemoWrites);

/** Long enough for a LinkedIn caption, short enough to bound the model call. */
const MAX_CAPTION_CHARS = 3000;

/** The networks a caption can be written for, and how each one wants to read. */
const CAPTION_TONES: Record<string, string> = {
  linkedin:
    "LinkedIn: a professional but human first-person post. A short, punchy hook line on its own, then a blank " +
    "line, then two or three short paragraphs (1-3 sentences each) each separated by a blank line so it reads " +
    "as distinct beats rather than one block. One or two well-placed emoji at most — as a bullet or accent, " +
    "never more than one per line. End with a blank line, then three to five specific, relevant hashtags on " +
    "their own line (no generic filler tags like #business or #success).",
  facebook:
    "Facebook: warm and conversational. A short hook line, a blank line, then one or two short paragraphs, each " +
    "separated by a blank line. Emoji welcome where they land naturally, not stacked. At most two specific " +
    "hashtags on their own line at the end.",
  twitter:
    "X (Twitter): one punchy post under 240 characters including the link. Short line breaks between the hook " +
    "and the point rather than one run-on sentence. One emoji at most. At most two specific hashtags.",
  whatsapp:
    "WhatsApp: a short direct message to a colleague. Two or three sentences, one blank line between them if it " +
    "reads better broken up. No hashtags.",
  telegram:
    "Telegram: brief and informative, two or three sentences. No hashtags.",
};

/** What every caption must clear, regardless of platform. */
const CAPTION_QUALITY_RULES =
  "Write like a specific, competent person who actually did the thing, not like ad copy. " +
  "No generic filler phrases (\"excited to announce\", \"game-changer\", \"in today's fast-paced world\", " +
  "\"we are thrilled\"), no empty buzzwords. Be concrete: name the actual thing, result or detail the author " +
  "gave you instead of describing it in vague terms.\n\n" +
  "Formatting: use real line breaks (\\n) between the hook, each beat, and the hashtag line — a caption that " +
  "reads as one dense paragraph is a fail, the way a short-form social post from a person, not a press " +
  "release, always breaks into short scannable lines with breathing room between them. Emoji are welcome where " +
  "the platform allows them (see below) — used sparingly and only where they add tone, never a row of them, " +
  "never one after every sentence.";

/**
 * Write a share caption.
 *
 * Runs through Orbit's model plumbing — the fallback chain, the timeouts, the
 * output sanitising — with its own system prompt, because under the support
 * prompt the model correctly refuses "write me a post" as off-topic.
 *
 * Admin-only, like the rest of sharing: this is metered model spend against the
 * workspace, and the caption describes numbers only an admin can publish.
 *
 * Everything the model is told comes from the server's own record of the
 * workspace, not from the request. A client that could supply the figures could
 * also supply instructions, and the caption goes out under the user's name.
 */
router.post("/:wid/share/caption", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  if (!orbitConfigured()) {
    return res.status(503).json({ error: "Caption writing is not available on this server." });
  }

  const platform = String(req.body?.platform ?? "linkedin");
  const tone = CAPTION_TONES[platform];
  if (!tone) return res.status(400).json({ error: "Unsupported platform." });

  /**
   * A caption about something the author names, rather than about their
   * dashboard.
   *
   * The scheduled-post composer writes posts on any subject, so it sends the
   * subject and nothing else. Without a topic this stays exactly what it was:
   * a caption describing the workspace's own public dashboard, which is why
   * the share-enabled check below only guards that path.
   */
  const topic = String(req.body?.topic ?? "").trim().slice(0, 500);

  if (topic) {
    const result = await askOrbit(
      `Write the post.\n\nWhat it is about:\n${topic}`,
      {
        systemPrompt:
          "You write social media posts for a person posting under their own name. " +
          `Write for ${tone}\n\n` +
          `${CAPTION_QUALITY_RULES}\n\n` +
          "Rules: write in the first person. Use only what the author told you — never invent figures, " +
          "dates, links or claims they did not give you. Do not use markdown, headings, bullet characters " +
          "or quotation marks around the post. " +
          "Return the post in the `reply` field and an empty `suggestions` array.",
        host: quantalogOrbitHost,
        tenantId: ws.id,
      },
    );

    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ caption: result.reply.trim().slice(0, MAX_CAPTION_CHARS) });
  }

  if (!ws.get("shareEnabled") || !ws.get("shareToken")) {
    return res.status(400).json({ error: "Turn the public dashboard on first." });
  }

  // The figures come from the same place the public page gets them, so the
  // caption cannot claim numbers the link does not actually show.
  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const siteIds = sites.map((s) => s.siteId as string);
  const stats = siteIds.length
    ? await computeStats(siteIds, "30d", {}, resolveWindow("30d"))
    : null;

  const publicUrl = `${process.env.PUBLIC_SITE_URL || "https://quantalog.daorbit.in"}/share/${ws.get("shareToken")}`;

  // Only panels the owner published may be described. Mentioning a breakdown
  // that is switched off would send people to a page missing what was promised.
  const panels = readSeoPanels(ws.get("sharePanels"));
  const visible = Object.entries(panels)
    .filter(([, on]) => on)
    .map(([key]) => key)
    .join(", ");

  const facts = [
    `Workspace name: ${ws.get("name")}`,
    `Public dashboard URL: ${publicUrl}`,
    stats && panels.totals
      ? `Last 30 days: ${stats.visitors} visitors, ${stats.pageviews} pageviews.`
      : "Visitor totals are not published on this dashboard — do not quote any figures.",
    `Sections the page shows: ${visible || "none"}.`,
  ].join("\n");

  const result = await askOrbit(
    `Write the caption.\n\n${facts}`,
    {
      systemPrompt:
        "You write social media captions for people sharing their public web-analytics dashboard, which is hosted on a product called Quantalog. " +
        `Write for ${tone}\n\n` +
        `${CAPTION_QUALITY_RULES}\n\n` +
        "Rules: write in the first person as the dashboard's owner. Use only the facts given — never invent figures, dates or claims. " +
        "Include the dashboard URL exactly as provided, on its own line. Do not use markdown, headings, bullet characters or quotation marks around the caption. " +
        "Return the caption in the `reply` field and an empty `suggestions` array.",
      host: quantalogOrbitHost,
      tenantId: ws.id,
    },
  );

  if (!result.ok) return res.status(result.status).json({ error: result.error });

  res.json({ caption: result.reply.trim().slice(0, MAX_CAPTION_CHARS) });
});

/** One exchange in a scheduling conversation, as the client replays it back. */
type PlanTurn = { role: "user" | "assistant"; content: string };

/** How many exchanges of a planning conversation are carried into the model. */
const MAX_PLAN_TURNS = 12;

/**
 * The models this route will start on, whatever the client asks for.
 *
 * An allow-list rather than a rejection, because the id arrives from the chat
 * panel's own picker via localStorage — it is a preference about support
 * answers, and a perfectly valid one there can be a model measured as unusable
 * here. Anything outside this set falls back to the route's own default rather
 * than failing the request: the author asked for a post, not for a model.
 */
const PLAN_MODELS = new Set(["llama-fast", "llama-8b"]);

 
router.post("/:wid/share/plan", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  if (!orbitConfigured()) {
    return res.status(503).json({ error: "Scheduling with Orbit is not available on this server." });
  }

  const platform = String(req.body?.platform ?? "linkedin");
  const tone = CAPTION_TONES[platform];
  if (!tone) return res.status(400).json({ error: "Unsupported platform." });

  const message = String(req.body?.message ?? "").trim().slice(0, 1000);
  if (!message) return res.status(400).json({ error: "Say something for Orbit to work from." });

  // Oldest first, and trimmed: a planning conversation that has run past a
  // dozen exchanges has stopped converging, and replaying all of it only
  // spends more of the author's quota on the same question.
  const turns: PlanTurn[] = Array.isArray(req.body?.turns)
    ? (req.body.turns as unknown[])
      .filter((t): t is PlanTurn =>
        !!t && typeof t === "object"
        && (((t as PlanTurn).role === "user") || ((t as PlanTurn).role === "assistant"))
        && typeof (t as PlanTurn).content === "string")
      .slice(-MAX_PLAN_TURNS)
      .map((t) => ({ role: t.role, content: t.content.slice(0, 2000) }))
    : [];

  // The author's own wall clock. Sent by the client because only the browser
  // knows which zone the person is in, and a schedule resolved in the server's
  // zone lands at the wrong hour.
  const nowLocal = String(req.body?.now ?? "").slice(0, 40) || new Date().toISOString();

  // Whatever the composer's fields already hold, so a conversation started
  // half-way through an edit builds on the post rather than replacing it.
  const current = req.body?.draft && typeof req.body.draft === "object"
    ? JSON.stringify(req.body.draft).slice(0, 4000)
    : "{}";

  const transcript = turns
    .map((t) => `${t.role === "user" ? "Author" : "You"}: ${t.content}`)
    .join("\n");

  const result = await askOrbit(
    [
      "Continue planning the post.",
      `The author's local date and time right now: ${nowLocal}`,
      `The composer's fields as they stand: ${current}`,
      transcript ? `Conversation so far:\n${transcript}` : "",
      `Author: ${message}`,
    ].filter(Boolean).join("\n\n"),
    {
      systemPrompt:
        "You help a person schedule a social media post that will go out under their own name. " +
        `Write any caption for ${tone}\n\n` +
        `${CAPTION_QUALITY_RULES}\n\n` +
        "Put a single JSON object in the `reply` field and nothing else — no markdown, no code fences, no prose " +
        "around it. Its keys are exactly:\n" +
        '  "message": string — what you say to the author. One short question when something is still open, or a ' +
        "one-line summary of the finished post when nothing is. Never more than two sentences.\n" +
        '  "done": boolean — true only when the caption is written AND the schedule is settled AND, for an ' +
        "Instagram post, an image is already attached, and you are showing the finished post for them to confirm.\n" +
        '  "needsImage": boolean — true when you are waiting on the author to attach an image.\n' +
        '  "caption": string — the post so far, first person, no markdown or surrounding quotes. "" until you ' +
        "have enough to write one.\n" +
        '  "name": string — a short private label for the author\'s own list, at most 60 characters. "" until known.\n' +
        '  "mode": "once" | "repeat".\n' +
        '  "date": "YYYY-MM-DD" — the day a one-off publishes, otherwise "".\n' +
        '  "time": "HH:MM" — 24-hour, the time a one-off publishes, otherwise "".\n' +
        '  "frequency": "daily" | "weekly" | "monthly" — the cadence of a repeating post.\n' +
        '  "hour": integer 0-23, "minute": integer 0-59 — the repeating time of day.\n' +
        '  "weekday": integer 0-6 where 0 is Sunday — the day a weekly post repeats on.\n' +
        '  "dayOfMonth": integer 1-28 — the day a monthly post repeats on.\n\n' +
        "Rules: ask ONE question at a time, and only about something you genuinely cannot infer — never ask again " +
        "about anything the author has already settled or that the composer's fields already hold. Normally you " +
        "need at most three things: what the post is about, when it goes out, and an image. Never ask the same " +
        "question, or a rephrasing of it, twice in a row — if the conversation shows you already asked what the " +
        "post is about and got any answer at all, even a short or vague one (\"just fun\", \"no\", \"idk\"), that " +
        "answer is final: write the caption from whatever you have rather than asking again. A caption from a thin " +
        "topic is always better than another question — write something concrete and specific to what little you " +
        "were given, never a placeholder, and let the author edit it after. An Instagram post " +
        "cannot publish without an image, so when the fields show none, ask for one and set needsImage true — the " +
        "author attaches it in the composer, and the next turn's fields will show it. On LinkedIn an image is " +
        "optional: offer it once, accept no for an answer, and never ask twice. Always return every key, " +
        "carrying forward what is already decided, so the author's form stays filled between turns. Resolve every " +
        "relative date against the author's local date and time given above, and never return a one-off date and " +
        "time in the past. A date with no stated time means 09:00. Use only what the author told you — never " +
        "invent figures, dates, links or claims they did not give you. Return an empty `suggestions` array.",
      host: quantalogOrbitHost,
      tenantId: ws.id,
      // The author's picked model, honoured as given.
      //
      // An earlier version forced a schema-honouring model here, on the theory
      // that this route needs JSON. Measured, that was wrong twice over: the
      // structured models are the ones currently failing, and DeepSeek — which
      // is not one — returns clean JSON and the best captions of anything in
      // the chain. `parsePlan` handles a fence or a stray sentence, so asking
      // nicely in the prompt is enough.
 
      modelId: PLAN_MODELS.has(String(req.body?.modelId ?? ""))
        ? String(req.body.modelId)
        : "llama-fast",

 

      exclude: ["gemini-flash", "gpt-oss", "gemma", "deepseek", "nemotron", "north-mini"],


      rawOutput: true,

      budgetMs: 32_000,
      attemptMs: 15_000,
    },
  );

  if (!result.ok) return res.status(result.status).json({ error: result.error });

  // A fence, a sentence before the object, a double-encoded string — see
  // `parsePlan` for the shapes models actually return here.
  const parsed = parsePlan(result.reply);
  if (!parsed) {
    // Logged with the model that produced it: an unstructured model failing
    // this consistently is a reason to reorder the chain, and that is invisible
    // if every failure looks the same from the outside.
    console.error(
      `[social] plan reply was not JSON (model ${result.model}): ${result.reply.slice(0, 300)}`,
    );
    return res.status(502).json({ error: "Orbit could not follow that. Try rewording it." });
  }

  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  // Every numeric field is clamped rather than rejected: a model that answers
  // "weekday: 7" meant Sunday, and failing the whole turn over it would send
  // the author back to the form they were trying to skip.
  const int = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    (allowed as readonly string[]).includes(String(v)) ? (String(v) as T) : fallback;

  const caption = str(parsed.caption, MAX_CAPTION_CHARS);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(str(parsed.date, 10)) ? str(parsed.date, 10) : "";
  const time = /^\d{2}:\d{2}$/.test(str(parsed.time, 5)) ? str(parsed.time, 5) : "";
  const mode = oneOf(parsed.mode, ["once", "repeat"] as const, "once");

  // An Instagram post with no image cannot publish, so it is never finished —
  // checked against the composer's own fields rather than the model's claim.
  const hasImage = !!(req.body?.draft as { image?: string } | undefined)?.image;
  const imageRequired = platform !== "linkedin" && !hasImage;

  // A turn claiming to be finished without a caption, or without the times its
  // own mode depends on, is not finished — treating it as done would put a
  // confirm button under an empty post.
  const complete = !!caption
    && (mode === "repeat" || (!!date && !!time))
    && !imageRequired;

  res.json({
    message: str(parsed.message, 400) || "What should this post be about?",
    done: parsed.done === true && complete,
    needsImage: parsed.needsImage === true || imageRequired,
    caption,
    name: str(parsed.name, 60),
    mode,
    date,
    time,
    frequency: oneOf(parsed.frequency, ["daily", "weekly", "monthly"] as const, "weekly"),
    hour: int(parsed.hour, 0, 23, 9),
    minute: int(parsed.minute, 0, 59, 0),
    weekday: int(parsed.weekday, 0, 6, 1),
    // 29-31 do not exist in every month, so a monthly post pinned there would
    // silently skip February. The composer's own picker stops at 28 too.
    dayOfMonth: int(parsed.dayOfMonth, 1, 28, 1),
  });
});

/**
 * Draw a picture for the post being planned.
 *
 * Same Cloudflare Flux call and Cloudinary upload/watermark pipeline as the
 * main Orbit assistant's "draw a picture" mode — this just puts it behind the
 * planner's own admin-only access check instead of the support chat's.
 */
router.post("/:wid/share/plan-image", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  if (!orbitConfigured()) {
    return res.status(503).json({ error: "Image generation is not available on this server." });
  }
  if (!cloudinaryConfigured()) {
    return res.status(503).json({ error: "Image uploads are not configured on this server." });
  }

  const plan = await effectiveOrbitPlan(ws.id);
  if (!plan.imageGeneration) {
    return planLimit(res, "Drawing pictures is part of Orbit Pro.", {
      kind: "orbit_image_generation",
    }, "plan_required");
  }

  const prompt = String(req.body?.prompt ?? "").trim().slice(0, 800);
  if (!prompt) return res.status(400).json({ error: "Say what to draw." });

  const result = await askOrbit(prompt, {
    generateImage: true,
    host: quantalogOrbitHost,
    tenantId: ws.id,
  });

  if (!result.ok) {
    if (result.quotaExceeded) {
      return planLimit(res, result.error, {
        kind: "orbit_questions",
        label: "Orbit questions",
        quota: plan.monthlyQuota,
      });
    }
    return res.status(result.status).json({ error: result.error });
  }

  if (!result.imageBase64) {
    return res.status(502).json({ error: "Orbit could not draw that. Try again." });
  }

  try {
    const brand = await resolveBranding(ws.id).catch(() => null);
    const watermark = brand?.watermarkAiImages !== false;

    const uploaded = await uploadImage({
      file: `data:image/jpeg;base64,${result.imageBase64}`,
      folder: `orbit/${ws.id}`,
      publicId: `social-plan-gen-${ws.id}-${Date.now()}`,
      transformation: watermark ? watermarkTransformation() : undefined,
    });

    res.json({ imageUrl: uploaded.url });
  } catch (e) {
    console.error("[social] generated image upload failed:", (e as Error).message);
    res.status(502).json({ error: "That image could not be saved. Try again." });
  }
});

export default router;
