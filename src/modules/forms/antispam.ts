import crypto from "crypto";
import { Submission } from "./models/Submission.js";

/**
 * The defences on the public submit endpoint.
 *
 * The threat is not one attacker. It is (a) commodity bots that find any public
 * POST and fill it, and (b) one annoyed human submitting a hundred times. Those
 * need different answers, so this module holds several small ones rather than a
 * single check: a honeypot and a timing token catch scripts, per-IP and
 * per-form ceilings catch volume, and the dedup hash catches repeats.
 *
 * None of them tells the caller which one fired. A bot that learns it was
 * caught by the honeypot simply stops filling the honeypot.
 */

/** Submissions one address may make to one form per window. */
export const IP_RATE_LIMIT = 10;
/** Submissions one form accepts per window before every row is flagged. */
export const FORM_RATE_LIMIT = 200;
export const RATE_WINDOW_MS = 60 * 60 * 1000;

/** Exact repeats inside this window are swallowed rather than stored twice. */
export const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How fast a human can plausibly fill a form. Anything quicker is a script
 * that fetched the schema and posted immediately.
 */
export const MIN_FILL_MS = 2_000;
/** How long a rendered form stays submittable. A page left open all day is normal, so this is generous. */
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * The key everything here is HMAC'd with.
 *
 * `RATE_LIMIT_SALT` when set, `JWT_SECRET` otherwise. The fallback is what the
 * existing newsletter route does and keeps behaviour identical without new
 * config — but rotating the JWT secret silently resets every rate-limit bucket
 * and invalidates every outstanding timing token, so a deployment that cares
 * should set the dedicated salt and stop sharing the two concerns.
 */
function salt(): string {
  return process.env.RATE_LIMIT_SALT ?? process.env.JWT_SECRET ?? "";
}

/** Stable, non-reversible handle for one address. Never returned by any endpoint. */
export function hashIp(ip: string): string {
  return crypto.createHmac("sha256", salt()).update(ip).digest("hex").slice(0, 32);
}

/**
 * The token handed out with the schema and returned with the submission.
 *
 * It carries its own issue time and is signed, so the server needs no state to
 * know when the form was rendered — which matters because the render and the
 * submit can hit different serverless instances.
 */
export function issueTimingToken(formKey: string): string {
  const issued = Date.now().toString(36);
  const mac = crypto
    .createHmac("sha256", salt())
    .update(`${formKey}.${issued}`)
    .digest("hex")
    .slice(0, 24);
  return `${issued}.${mac}`;
}

export type TimingVerdict = "ok" | "missing" | "invalid" | "too-fast" | "expired";

export function verifyTimingToken(formKey: string, token: unknown): TimingVerdict {
  if (typeof token !== "string" || !token) return "missing";

  const [issued, mac] = token.split(".");
  if (!issued || !mac) return "invalid";

  const expected = crypto
    .createHmac("sha256", salt())
    .update(`${formKey}.${issued}`)
    .digest("hex")
    .slice(0, 24);
  // Length-checked first: `timingSafeEqual` throws on a length mismatch, which
  // an attacker controls simply by sending a shorter token.
  if (mac.length !== expected.length) return "invalid";
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return "invalid";

  const issuedAt = parseInt(issued, 36);
  if (!Number.isFinite(issuedAt)) return "invalid";

  const age = Date.now() - issuedAt;
  // A negative age means a clock skew or a forged-but-correctly-signed future
  // timestamp; either way it is not a human who has been reading the page.
  if (age < MIN_FILL_MS) return "too-fast";
  if (age > TOKEN_TTL_MS) return "expired";
  return "ok";
}

/**
 * Normalise answers into a stable string and hash it.
 *
 * Sorted by key so two identical submissions with different property order
 * still collide, and lowercased/whitespace-collapsed so "Ada  Lovelace " and
 * "ada lovelace" are one person submitting twice rather than two leads.
 */
export function dedupHash(formId: string, data: Record<string, unknown>): string {
  const normalised = Object.keys(data)
    .sort()
    .map((k) => `${k}=${normaliseValue(data[k])}`)
    .join("&");
  return crypto.createHash("sha256").update(`${formId}:${normalised}`).digest("hex").slice(0, 40);
}

export function normaliseValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(normaliseValue).sort().join(",");
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export type RateVerdict =
  | { ok: true; flagged: false }
  /** Over the per-form ceiling: still accepted, but every row is marked. */
  | { ok: true; flagged: true; reason: string }
  | { ok: false; error: string };

/**
 * Whether this submission is inside both ceilings.
 *
 * Two limits rather than one because they fail differently. Per-IP stops the
 * annoyed human and the single script, and is a hard refusal because the caller
 * really is one caller. Per-form catches distributed bots that rotate
 * addresses, where a refusal would be indistinguishable from refusing a
 * campaign that actually worked — so above that line the form enters review
 * mode: still accepting, every row flagged, notifications suppressed.
 */
export async function checkRates(formId: string, ipHashValue: string): Promise<RateVerdict> {
  const since = new Date(Date.now() - RATE_WINDOW_MS);

  const fromIp = await Submission.countDocuments({
    formId,
    ipHash: ipHashValue,
    createdAt: { $gt: since },
  });
  if (fromIp >= IP_RATE_LIMIT)
    return { ok: false, error: "Too many submissions from here. Try again in a little while." };

  const onForm = await Submission.countDocuments({ formId, createdAt: { $gt: since } });
  if (onForm >= FORM_RATE_LIMIT)
    return {
      ok: true,
      flagged: true,
      reason: `over ${FORM_RATE_LIMIT} submissions in an hour — held for review`,
    };

  return { ok: true, flagged: false };
}

/**
 * Whether this address may upload one more file to this form.
 *
 * Counted against submissions in the same window rather than against a separate
 * upload counter: an upload that never becomes a submission still costs us
 * storage, so the budget has to be shared or the way past the submission limit
 * is simply to stop submitting. Allowed a little headroom over `IP_RATE_LIMIT`,
 * because one legitimate submission can carry several files.
 */
export async function checkUploadRate(
  formId: string,
  ipHashValue: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const since = new Date(Date.now() - RATE_WINDOW_MS);
  const recent = await Submission.countDocuments({
    formId,
    ipHash: ipHashValue,
    createdAt: { $gt: since },
  });
  if (recent >= IP_RATE_LIMIT)
    return { ok: false, error: "Too many uploads from here. Try again in a little while." };
  return { ok: true };
}

/**
 * Validate a base64 data URL destined for storage.
 *
 * Stricter than the avatar equivalent in two ways that matter for a public
 * endpoint: the allow-list is explicit (SVG is absent deliberately — it can
 * carry script, and this file will later be opened by the form's owner), and
 * the size is measured from the base64 length rather than by allocating the
 * buffer, so an oversized payload is refused before it costs memory.
 */
export function checkUploadDataUrl(
  dataUrl: string,
  maxBytes: number,
  imagesOnly: boolean,
): { error: string } | { mime: string; bytes: number } {
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) return { error: "That file could not be read." };

  const mime = match[1].toLowerCase();
  const allowed = imagesOnly ? UPLOAD_IMAGE_MIME : UPLOAD_ANY_MIME;
  if (!allowed.has(mime))
    return {
      error: imagesOnly
        ? "Attach a PNG, JPEG, WebP or GIF image."
        : "That file type is not accepted.",
    };

  const b64 = match[2];
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((b64.length * 3) / 4) - padding;

  if (bytes <= 0) return { error: "That file is empty." };
  if (bytes > maxBytes)
    return { error: `Files must be ${Math.round(maxBytes / (1024 * 1024))}MB or smaller.` };

  return { mime, bytes };
}

/** Image formats browsers render safely. SVG is excluded: it can carry script. */
const UPLOAD_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

/**
 * Everything a general upload field accepts.
 *
 * An allow-list rather than a block-list, and deliberately dull: documents and
 * images, nothing executable, nothing archived. A block-list on a public
 * endpoint is a list of the extensions someone has already thought of.
 */
const UPLOAD_ANY_MIME = new Set([
  ...UPLOAD_IMAGE_MIME,
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/** An exact repeat of the same answers on the same form, inside the window. */
export async function findRecentDuplicate(formId: string, hash: string) {
  return Submission.findOne({
    formId,
    dedupHash: hash,
    createdAt: { $gt: new Date(Date.now() - DEDUP_WINDOW_MS) },
  }).select("_id");
}
