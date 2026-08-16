import crypto from "crypto";

/**
 * Anti-abuse primitives for public form submission.
 *
 * The threat is two different shapes: commodity bots that find any public
 * POST, and one annoyed human submitting repeatedly. Honeypot and the timing
 * token catch the first without costing a real visitor anything; rate limits
 * and dedup catch the second. See `FORMS.md` for the full reasoning.
 */

/**
 * Keyed with the server secret so a leaked database of hashes cannot be
 * walked back to addresses/IPs by hashing candidates — matches
 * `newsletter-public.ts` and `contact-public.ts`.
 *
 * Reusing `JWT_SECRET` here as-is, same as those two. If this ever moves into
 * a shared helper across modules, give it its own `RATE_LIMIT_SALT` first —
 * rotating `JWT_SECRET` would otherwise silently reset every rate-limit
 * bucket in the app at once.
 */
function keyedHash(value: string): string {
  const secret = process.env.JWT_SECRET ?? "";
  return crypto.createHmac("sha256", secret).update(value).digest("hex").slice(0, 32);
}

export function hashIp(ip: string): string {
  return keyedHash(ip);
}

/**
 * Exact-repeat detection over the submitted answers.
 *
 * Keys sorted before hashing so field order in the request body (which the
 * client fully controls) can't produce two hashes for the same answers.
 */
export function dedupHash(data: Record<string, unknown>): string {
  const normalized = Object.keys(data)
    .sort()
    .map((k) => `${k}=${String(data[k] ?? "").trim().toLowerCase()}`)
    .join("&");
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

const TIMING_TOKEN_TTL_MS = 30 * 60 * 1000;
/** Humans cannot fill a form in under this. Catches scripted posts that ignore the honeypot. */
const MIN_FILL_MS = 2000;

/**
 * A short-lived signed timestamp, issued when the public schema is fetched
 * and checked back on submit. HMAC rather than a DB row: it needs no storage
 * and no cleanup, and the only thing it has to prove is "this timestamp was
 * issued by us and hasn't been tampered with."
 */
export function issueTimingToken(): string {
  const ts = Date.now().toString();
  const sig = keyedHash(ts);
  return `${ts}.${sig}`;
}

/**
 * Whether a timing token is valid and old enough to reflect a human filling
 * the form, rather than a script that posted immediately.
 */
export function checkTimingToken(token: unknown): boolean {
  if (typeof token !== "string") return false;
  const [ts, sig] = token.split(".");
  if (!ts || !sig) return false;
  if (keyedHash(ts) !== sig) return false;

  const issuedAt = Number(ts);
  if (!Number.isFinite(issuedAt)) return false;

  const age = Date.now() - issuedAt;
  return age >= MIN_FILL_MS && age <= TIMING_TOKEN_TTL_MS;
}

/** A hidden field no human fills in. A non-empty value means a bot. */
export function isHoneypotTripped(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
