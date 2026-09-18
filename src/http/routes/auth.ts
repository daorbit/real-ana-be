import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import QRCode from "qrcode";
import { encryptSecret, decryptSecret } from "../../shared/utils/crypto-box.js";
import { generateTotpSecret, totpKeyUri, verifyTotpCode } from "../../shared/utils/totp.js";
import { User } from "../../modules/identity/models/User.js";
import { PendingSignup } from "../../modules/identity/models/PendingSignup.js";
import { Membership } from "../../modules/workspace/models/Membership.js";
import { Workspace } from "../../modules/workspace/models/Workspace.js";
import { WorkspaceInvite } from "../../modules/workspace/models/WorkspaceInvite.js";
import { PasswordReset } from "../../modules/identity/models/PasswordReset.js";
import { mailConfigured, sendOne, sendOtpEmail, sendResetEmail, sendPasswordChangedEmail, sendWelcomeEmail } from "../../infra/mail/mailer.js";
import { getDemoDailyLimit } from "../../config/AppSetting.js";
import { tryStartDemo } from "../../modules/billing/demo-limit.js";
import { googleConfigured, verifyGoogleCredential } from "../../infra/http-client/google-auth.js";
import { turnstileConfigured, verifyTurnstileToken } from "../../infra/http-client/turnstile.js";
import {
  checkImageDataUrl, cloudinaryConfigured, deleteImage, uploadImage,
} from "../../infra/storage/cloudinary.js";
import { sendTwoFactorBackupCodesEmail, sendAccountLockedEmail } from "../../infra/mail/mailer.js";
import { emitTo } from "../../modules/notifications/notify.service.js";
import {
  signToken, signDemoToken, requireAuth, blockDemoWrites, AuthedRequest,
  signPending2faToken, verifyPending2faToken,
} from "../middleware/auth.js";

const router = Router();

/** A recovery code in the `XXXX-XXXX` shape people expect from this kind of list. */
function randomBackupCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — easy to misread
  const part = () =>
    Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `${part()}-${part()}`;
}

/**
 * A generic per-key attempt counter, in memory only. Covers both 2FA-at-login
 * verification and the screen-lock unlock — anything where a bcrypt/TOTP
 * compare is the only gate and there is no captcha in front of it, unlike
 * `/login` which has Turnstile. Losing counts on a restart, or having them
 * miss across instances in a multi-process deploy, just gives an attacker a
 * fresh window rather than a free pass, so this doesn't need to be durable or
 * shared like the account data it's protecting.
 */
const attemptCounters = new Map<string, { count: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const ATTEMPT_COOLDOWN_MS = 15 * 60 * 1000;

function checkAttemptThrottle(key: string): number | null {
  const entry = attemptCounters.get(key);
  if (entry && entry.lockedUntil > Date.now()) return entry.lockedUntil;
  return null;
}

function recordAttemptFailure(key: string): void {
  const entry = attemptCounters.get(key) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + ATTEMPT_COOLDOWN_MS;
    entry.count = 0;
  }
  attemptCounters.set(key, entry);
}

function clearAttemptFailures(key: string): void {
  attemptCounters.delete(key);
}

/**
 * The demo session's stand-in user id.
 *
 * Deliberately not a real document: the demo never reads or writes the
 * database. A fixed, obviously-synthetic id keeps the token well-formed while
 * matching nothing in the users collection.
 */
const DEMO_USER_ID = "000000000000000000000000";

/** The demo session's user, assembled without touching the database. */
function demoUser() {
  return {
    id: DEMO_USER_ID,
    email: "demo@quantalog.app",
    name: "Demo User",
    firstName: "Demo",
    lastName: "User",
    mobile: "",
    avatarUrl: "",
    dateLocale: "",
    timezone: "",
    role: "user" as const,
    demo: true,
  };
}

/**
 * The shape every auth response returns — one place, so they can't drift.
 *
 * Async because it attaches `billing`: login, signup, and Google sign-in all
 * build their response through this function, and every one of them needs
 * the plan/quota state just as much as `/me` does — a client that logs in
 * and never calls `/me` again (the common case) would otherwise never learn
 * what plan it's on until the next full page load.
 */
async function publicUser(user: InstanceType<typeof User>) {
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
    /** Lets the client show "connected with Google" instead of guessing. */
    googleLinked: Boolean(user.googleId),
    /** The same, for LinkedIn sign-in. */
    linkedinLinked: Boolean(user.linkedinId),
    /** False for social-only accounts, which have never set one. */
    hasPassword: Boolean(user.passwordHash),
    totpEnabled: Boolean(user.totpEnabled),
    screenLockEnabled: Boolean(user.screenLockEnabled),
    hasPin: Boolean(user.pinHash),
    locked: Boolean(user.lockedAt),

    signupSource: user.passwordHash
      ? "email"
      : user.googleId
        ? "google"
        : user.linkedinId
          ? "linkedin"
          : "email",

    ...(await accessSummary(user.id)),
  };
}


async function accessSummary(userId: string) {
  const memberships = await Membership.find({ userId }).select("workspaceId role").lean();

  const workspaces = await Workspace.find({
    _id: { $in: memberships.map((m) => m.workspaceId) },
  })
    .select("name slug")
    .sort({ createdAt: -1 })
    .lean();

  const roleByWorkspace = new Map(memberships.map((m) => [String(m.workspaceId), m.role]));

  // Invitations addressed to this account's email that are still live. Expired
  // ones are omitted rather than shown as actionable — the link behind them is
  // already refused at accept time.
  const user = await User.findById(userId).select("email").lean();
  const pending = user?.email
    ? await WorkspaceInvite.find({
        email: String(user.email).toLowerCase(),
        acceptedAt: null,
        expiresAt: { $gt: new Date() },
      })
        .select("workspaceId role token expiresAt")
        .lean()
    : [];

  const invitedWorkspaces = await Workspace.find({
    _id: { $in: pending.map((i) => i.workspaceId) },
  })
    .select("name")
    .lean();
  const nameByWorkspace = new Map(invitedWorkspaces.map((w) => [String(w._id), w.name]));

  return {
    /** Workspaces this account is a member of — accepted access, usable now. */
    workspaceAccess: workspaces.map((w) => ({
      workspaceId: String(w._id),
      name: w.name as string,
      slug: w.slug as string,
      role: roleByWorkspace.get(String(w._id)),
    })),
    /**
     * Invitations waiting to be accepted. The token is included so the client
     * can link straight to the accept page — it was already emailed to this
     * address, so returning it to the account that owns that address reveals
     * nothing it did not already have.
     */
    pendingInvites: pending.map((i) => ({
      workspaceId: String(i.workspaceId),
      workspaceName: nameByWorkspace.get(String(i.workspaceId)) ?? "",
      role: i.role,
      token: i.token,
      expiresAt: i.expiresAt,
    })),
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

/* ---------------------------- signup with OTP ----------------------------- */

/** How long a code stays valid. Long enough for a slow inbox, short enough to matter. */
const OTP_TTL_MINUTES = 10;
/** Wrong guesses allowed before the pending signup is destroyed outright. */
const OTP_MAX_ATTEMPTS = 5;
/** Codes per pending signup, counting the first. Bounds mail sent per address. */
const OTP_MAX_SENDS = 5;
/** Minimum gap between codes, so "resend" can't be leaned on. */
const OTP_RESEND_GAP_MS = 60 * 1000;

/**
 * A six-digit code, from the cryptographic generator.
 *
 * `Math.random` is predictable enough to be guessable given a few samples,
 * which for a credential — however short-lived — is the wrong trade. The
 * modulo bias across 000000–999999 is negligible at this range.
 */
function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}


function welcomeInBackground(email: string, name?: string): void {
  if (!mailConfigured()) return;

  void sendWelcomeEmail({ email, name }).catch((e: unknown) => {
    console.error("[auth] welcome email failed:", e instanceof Error ? e.message : e);
  });
}

router.post("/signup", async (req, res) => {
  try {
    const { email, password, name } = req.body ?? {};

    const invalid = signupError(req.body ?? {});
    if (invalid) return res.status(400).json({ error: invalid });

    if (!mailConfigured()) {
      return res.status(503).json({
        error: "email verification is unavailable right now — please try again later",
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanName = String(name).trim();
    const parts = cleanName.split(/\s+/);

    const taken = await User.findOne({ email: cleanEmail });
    if (taken) {
      // Tell the real owner, and only the real owner, that the address is in
      // use — over email, where an enumerating caller cannot read it. The HTTP
      // response below is identical either way.
      try {
        await sendOne(
          { email: cleanEmail, name: taken.name },
          "Someone tried to sign up with your email",
          `Hi ${taken.name},\n\nSomeone just tried to create a Quantalog account with this email address, but you already have one.\n\nIf that was you, log in instead — or reset your password if you've forgotten it.\n\nIf it wasn't, you can safely ignore this message. Nothing about your account has changed.`,
        );
      } catch {
        // The caller must not learn that this branch was taken, so a mail
        // failure here is logged and swallowed rather than surfaced.
        console.warn(`[signup] could not send already-registered notice to ${cleanEmail}`);
      }
      return res.status(202).json({ pending: true, email: cleanEmail, expiresInMinutes: OTP_TTL_MINUTES });
    }

    const code = generateOtp();
    const [passwordHash, codeHash] = await Promise.all([
      bcrypt.hash(password, 10),
      bcrypt.hash(code, 10),
    ]);

    // Restarting a signup replaces the previous pending attempt wholesale —
    // new password, new name, new code, attempts back to zero. `upsert` keeps
    // that a single write, and the unique index on email makes it safe.
    await PendingSignup.findOneAndUpdate(
      { email: cleanEmail },
      {
        email: cleanEmail,
        passwordHash,
        name: cleanName,
        firstName: parts[0] ?? "",
        lastName: parts.slice(1).join(" "),
        codeHash,
        expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
        attempts: 0,
        sends: 1,
        lastSentAt: new Date(),
        createdAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    try {
      await sendOtpEmail({ email: cleanEmail, name: cleanName }, code, OTP_TTL_MINUTES);
    } catch (e) {
      // Nothing was created but the pending record, and it is useless without a
      // delivered code — drop it so a retry starts clean.
      await PendingSignup.deleteOne({ email: cleanEmail });
      console.error("[signup] otp send failed:", e instanceof Error ? e.message : e);
      return res.status(502).json({ error: "could not send the verification email — check the address and try again" });
    }

    res.status(202).json({ pending: true, email: cleanEmail, expiresInMinutes: OTP_TTL_MINUTES });
  } catch {
    res.status(500).json({ error: "signup failed" });
  }
});


router.post("/signup/verify", async (req, res) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const code = String(req.body?.code ?? "").trim();

    if (!email || !code) return res.status(400).json({ error: "email and code required" });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "enter the 6-digit code" });

    const pending = await PendingSignup.findOne({ email });

    if (!pending) {
      return res.status(400).json({
        error: "no signup is in progress for that address — it may already be registered, so try logging in",
        restart: true,
      });
    }

    // The TTL sweep is periodic, so a stale document can outlive its own
    // deadline by a few minutes; the explicit check is what actually enforces it.
    if (pending.expiresAt.getTime() < Date.now()) {
      await pending.deleteOne();
      return res.status(400).json({ error: "that code has expired — start again to get a new one", restart: true });
    }

    const ok = await bcrypt.compare(code, pending.codeHash);
    if (!ok) {
      pending.attempts += 1;
      // Past the cap the record goes, rather than sitting there absorbing
      // guesses — six digits is a small enough space that an unbounded attempt
      // count is the whole vulnerability.
      if (pending.attempts >= OTP_MAX_ATTEMPTS) {
        await pending.deleteOne();
        return res.status(429).json({ error: "too many incorrect codes — start again to get a new one", restart: true });
      }
      await pending.save();
      return res.status(400).json({
        error: "that code isn't right",
        attemptsLeft: OTP_MAX_ATTEMPTS - pending.attempts,
      });
    }

    // Between sending the code and verifying it, the address could have been
    // claimed by another signup that finished first.
    const taken = await User.findOne({ email });
    if (taken) {
      await pending.deleteOne();
      return res.status(409).json({ error: "that email was just registered — try logging in" });
    }

    // `role` is deliberately not read from the pending record or the body — a
    // signup cannot ask to be an admin. The schema default applies.
    const user = await User.create({
      email: pending.email,
      passwordHash: pending.passwordHash,
      name: pending.name,
      firstName: pending.firstName,
      lastName: pending.lastName,
    });
    await pending.deleteOne();

    welcomeInBackground(user.email, user.name);

    const token = signToken(user.id);
    res.status(201).json({ token, user: await publicUser(user) });
  } catch {
    res.status(500).json({ error: "verification failed" });
  }
});


router.post("/signup/resend", async (req, res) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "email required" });

    const pending = await PendingSignup.findOne({ email });
    if (!pending) {
      return res.status(404).json({ error: "no signup in progress for that address", restart: true });
    }

    const since = Date.now() - new Date(pending.lastSentAt).getTime();
    if (since < OTP_RESEND_GAP_MS) {
      const seconds = Math.ceil((OTP_RESEND_GAP_MS - since) / 1000);
      res.set("Retry-After", String(seconds));
      return res.status(429).json({ error: `please wait ${seconds}s before asking for another code`, retryInSeconds: seconds });
    }

    if (pending.sends >= OTP_MAX_SENDS) {
      await pending.deleteOne();
      return res.status(429).json({ error: "too many codes requested — start again", restart: true });
    }

    const code = generateOtp();
    pending.codeHash = await bcrypt.hash(code, 10);
    pending.expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
    pending.attempts = 0;
    pending.sends += 1;
    pending.lastSentAt = new Date();
    await pending.save();

    try {
      await sendOtpEmail({ email: pending.email, name: pending.name }, code, OTP_TTL_MINUTES);
    } catch (e) {
      console.error("[signup] otp resend failed:", e instanceof Error ? e.message : e);
      return res.status(502).json({ error: "could not send the verification email — try again in a moment" });
    }

    res.json({ ok: true, expiresInMinutes: OTP_TTL_MINUTES });
  } catch {
    res.status(500).json({ error: "could not resend the code" });
  }
});

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 12 * 60 * 60 * 1000;

router.post("/login", async (req, res) => {
  try {
    const { email, password, turnstileToken } = req.body ?? {};
    if (!email || !password)
      return res.status(400).json({ error: "email, password required" });

    if (turnstileConfigured()) {
      const check = await verifyTurnstileToken(turnstileToken, req.ip);
      if (!check.ok)
        return check.reason === "unavailable"
          ? res.status(503).json({
              error: "could not complete the security check — try again in a moment",
            })
          : res.status(400).json({
              error: "security check failed — please try again",
              turnstile: true,
            });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: "invalid credentials" });

    // Locked from a previous run of wrong passwords — refused outright, since
    // letting a correct password through here would make the lock pointless
    // against someone who eventually guesses right.
    if (user.loginLockedUntil && user.loginLockedUntil.getTime() > Date.now()) {
      return res.status(423).json({
        error: "too many failed attempts — this account is temporarily locked",
        locked: true,
        lockedUntil: user.loginLockedUntil.toISOString(),
      });
    }

    // A Google-only account has no password to compare against. Say so plainly:
    // "invalid credentials" would send someone hunting for a password that was
    // never set.
    if (!user.passwordHash)
      return res.status(401).json({
        error: "this account uses Google sign-in — continue with Google",
        google: true,
      });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      user.loginFailCount = (user.loginFailCount ?? 0) + 1;
      if (user.loginFailCount >= LOGIN_MAX_ATTEMPTS) {
        const until = new Date(Date.now() + LOGIN_LOCK_MS);
        user.loginLockedUntil = until;
        user.loginFailCount = 0;
        await user.save();
        sendAccountLockedEmail({ email: user.email, name: user.name }, until).catch((e) =>
          console.error("[login] account-locked notice failed:", (e as Error)?.message)
        );
        // Also in the dashboard, for whenever they next get in. If the lockout
        // was someone else trying their password, this is the record that
        // survives a deleted email.
        await emitTo({
          type: "security.alert",
          userId: String(user._id),
          data: {
            what: "Sign-in was locked for 12 hours after five wrong passwords.",
            event: "login.locked",
            lockedUntil: until,
          },
          link: "/app/settings",
        });
        return res.status(423).json({
          error: "too many failed attempts — this account is temporarily locked",
          locked: true,
          lockedUntil: until.toISOString(),
        });
      }
      await user.save();
      return res.status(401).json({ error: "invalid credentials" });
    }

    if (user.loginFailCount) {
      user.loginFailCount = 0;
      await user.save();
    }

    // Password proven, but that is only the first factor on an account with
    // 2FA on. A pending token stands in for a session until the code step
    // clears it — the client never sees a real token until then.
    if (user.totpEnabled) {
      return res.json({ requires2fa: true, pendingToken: signPending2faToken(user.id) });
    }

    const token = signToken(user.id);
    res.json({ token, user: await publicUser(user) });
  } catch {
    res.status(500).json({ error: "login failed" });
  }
});


router.post("/2fa/verify", async (req, res) => {
  try {
    const { pendingToken, code } = req.body ?? {};
    if (!pendingToken || !code)
      return res.status(400).json({ error: "pendingToken, code required" });

    const userId = verifyPending2faToken(pendingToken);
    if (!userId) return res.status(401).json({ error: "invalid or expired login attempt" });

    const throttleKey = `2fa:${userId}`;
    const throttledUntil = checkAttemptThrottle(throttleKey);
    if (throttledUntil)
      return res.status(429).json({
        error: "too many attempts — try again later",
        retryAt: new Date(throttledUntil).toISOString(),
      });

    const user = await User.findById(userId);
    if (!user || !user.totpEnabled || !user.totpSecretEnc)
      return res.status(401).json({ error: "invalid or expired login attempt" });

    const cleanCode = String(code).replace(/\s+/g, "");
    const secret = decryptSecret(user.totpSecretEnc);

    const totpOk = secret && /^\d{6}$/.test(cleanCode) ? await verifyTotpCode(cleanCode, secret) : false;

    if (totpOk) {
      clearAttemptFailures(throttleKey);
      const token = signToken(user.id);
      return res.json({ token, user: await publicUser(user) });
    }

    // Not a valid live code — try it as a backup code instead. Each one is
    // single-use, so a match is removed from the list on the spot rather
    // than merely checked.
    const hashes = user.totpBackupCodeHashes ?? [];
    let matchedIndex = -1;
    for (let i = 0; i < hashes.length; i++) {
      if (await bcrypt.compare(cleanCode.toUpperCase(), hashes[i])) {
        matchedIndex = i;
        break;
      }
    }
    if (matchedIndex === -1) {
      recordAttemptFailure(throttleKey);
      return res.status(401).json({ error: "invalid code" });
    }

    user.totpBackupCodeHashes = hashes.filter((_, i) => i !== matchedIndex);
    await user.save();
    clearAttemptFailures(throttleKey);
    const token = signToken(user.id);
    res.json({ token, user: await publicUser(user), backupCodeUsed: true });
  } catch {
    res.status(500).json({ error: "verification failed" });
  }
});


router.post("/2fa/setup", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "not found" });
    if (user.totpEnabled) return res.status(400).json({ error: "2fa is already on" });

    const secret = generateTotpSecret();
    const otpauth = totpKeyUri(user.email, secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth);

    res.json({ secret, qrDataUrl });
  } catch {
    res.status(500).json({ error: "could not start 2fa setup" });
  }
});


router.post("/2fa/enable", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { secret, code } = req.body ?? {};
    if (!secret || !code) return res.status(400).json({ error: "secret, code required" });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "not found" });
    if (user.totpEnabled) return res.status(400).json({ error: "2fa is already on" });

    if (!(await verifyTotpCode(String(code).replace(/\s+/g, ""), secret)))
      return res.status(400).json({ error: "that code didn't match — try the next one" });

    const backupCodes = Array.from({ length: 10 }, () => randomBackupCode());
    const hashes = await Promise.all(backupCodes.map((c) => bcrypt.hash(c, 10)));

    user.totpEnabled = true;
    user.totpSecretEnc = encryptSecret(secret);
    user.totpBackupCodeHashes = hashes;
    await user.save();

    // Shown once, in the clear, right here in the response — and mailed once,
    // too, so a codes list lost by closing the tab too soon isn't gone for
    // good.
    sendTwoFactorBackupCodesEmail({ email: user.email, name: user.name }, backupCodes).catch((e) =>
      console.error("[2fa-enable] backup codes email failed:", (e as Error)?.message)
    );

    res.json({ backupCodes });
  } catch {
    res.status(500).json({ error: "could not enable 2fa" });
  }
});

/** Turns 2FA off. Requires the current password — this is a security
 * downgrade, and a stolen session token alone should not be enough to
 * quietly remove the second factor protecting the account it belongs to. */
router.post("/2fa/disable", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { password } = req.body ?? {};
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "not found" });
    if (!user.totpEnabled) return res.status(400).json({ error: "2fa is already off" });

    if (!user.passwordHash || !(await bcrypt.compare(password ?? "", user.passwordHash)))
      return res.status(401).json({ error: "incorrect password" });

    user.totpEnabled = false;
    user.totpSecretEnc = "";
    user.totpBackupCodeHashes = [];
    await user.save();

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "could not disable 2fa" });
  }
});

function pinError(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return "PIN must be 4 digits";
  return null;
}

/** Sets or replaces the screen-lock PIN. Requires the current PIN once one
 * exists, same "prove you still control this" rule as password/2FA changes;
 * the very first PIN needs no proof since there is nothing yet to protect. */
router.post("/me/pin", requireAuth, blockDemoWrites, async (req: AuthedRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "not found" });

    const currentPin = String(req.body?.currentPin ?? "");
    const newPin = String(req.body?.newPin ?? "");

    if (user.pinHash) {
      if (!currentPin) return res.status(400).json({ error: "current PIN required" });
      if (!(await bcrypt.compare(currentPin, user.pinHash)))
        return res.status(401).json({ error: "current PIN is incorrect" });
    }

    const invalid = pinError(newPin);
    if (invalid) return res.status(400).json({ error: invalid });

    user.pinHash = await bcrypt.hash(newPin, 10);
    await user.save();

    res.json(await publicUser(user));
  } catch {
    res.status(500).json({ error: "could not update the PIN" });
  }
});

/** Turns the idle screen lock on. A PIN is mandatory unless TOTP is already
 * enabled — unlocking has to have at least one working method, and TOTP alone
 * covers that. */
router.post("/me/screen-lock/enable", requireAuth, blockDemoWrites, async (req: AuthedRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "not found" });

    const pin = req.body?.pin !== undefined ? String(req.body.pin) : "";

    if (!user.totpEnabled && !user.pinHash) {
      if (!pin) return res.status(400).json({ error: "a PIN is required unless 2FA is already on" });
      const invalid = pinError(pin);
      if (invalid) return res.status(400).json({ error: invalid });
      user.pinHash = await bcrypt.hash(pin, 10);
    }

    user.screenLockEnabled = true;
    await user.save();

    res.json(await publicUser(user));
  } catch {
    res.status(500).json({ error: "could not enable the screen lock" });
  }
});

/** Turns the screen lock off. Requires the current password, same security-
 * downgrade rule as disabling 2FA. */
router.post("/me/screen-lock/disable", requireAuth, blockDemoWrites, async (req: AuthedRequest, res: Response) => {
  try {
    const { password } = req.body ?? {};
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "not found" });

    if (!user.passwordHash || !(await bcrypt.compare(password ?? "", user.passwordHash)))
      return res.status(401).json({ error: "incorrect password" });

    user.screenLockEnabled = false;
    user.lockedAt = null;
    await user.save();

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "could not disable the screen lock" });
  }
});

/** Called by the client's idle timer. Flips the server-side lock flag that
 * `requireUnlocked` checks on every subsequent request — the enforcement
 * lives here, not in whatever overlay the client happens to render. */
router.post("/lock", requireAuth, async (req: AuthedRequest, res: Response) => {
  if (req.isDemo) return res.json({ ok: true });
  try {
    const user = await User.findById(req.userId).select("screenLockEnabled");
    if (!user) return res.status(404).json({ error: "not found" });
    if (!user.screenLockEnabled) return res.json({ ok: true, locked: false });

    await User.updateOne({ _id: req.userId }, { lockedAt: new Date() });
    res.json({ ok: true, locked: true });
  } catch {
    res.status(500).json({ error: "could not lock" });
  }
});

/** Clears the lock flag once the PIN or a live TOTP code checks out. */
router.post("/unlock", requireAuth, async (req: AuthedRequest, res: Response) => {
  if (req.isDemo) return res.json({ ok: true });
  try {
    const userId = req.userId!;
    const throttleKey = `unlock:${userId}`;
    const throttledUntil = checkAttemptThrottle(throttleKey);
    if (throttledUntil)
      return res.status(429).json({
        error: "too many attempts — try again later",
        retryAt: new Date(throttledUntil).toISOString(),
      });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "not found" });
    if (!user.lockedAt) return res.json({ ok: true });

    const { pin, totpCode } = req.body ?? {};
    let ok = false;

    if (totpCode && user.totpEnabled && user.totpSecretEnc) {
      const cleanCode = String(totpCode).replace(/\s+/g, "");
      const secret = decryptSecret(user.totpSecretEnc);

      ok = Boolean(secret) && /^\d{6}$/.test(cleanCode) ? await verifyTotpCode(cleanCode, secret!) : false;
    } else if (pin && user.pinHash) {
      ok = await bcrypt.compare(String(pin), user.pinHash);
    }

    if (!ok) {
      recordAttemptFailure(throttleKey);
      return res.status(401).json({ error: "incorrect PIN or code" });
    }

    clearAttemptFailures(throttleKey);
    user.lockedAt = null;
    await user.save();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "could not unlock" });
  }
});


router.post("/google", async (req, res) => {
  try {
    if (!googleConfigured())
      return res.status(503).json({ error: "Google sign-in is not configured" });

    const credential = String(req.body?.credential ?? "");
    if (!credential) return res.status(400).json({ error: "credential required" });

    const profile = await verifyGoogleCredential(credential);
    if (!profile) return res.status(401).json({ error: "could not verify that Google sign-in" });

    let user = await User.findOne({ email: profile.email });
    let created = false;

    if (!user) {
      const [firstName, ...rest] = profile.name.split(" ");
      // No passwordHash: this account has no password until its owner sets one.
      // `role` is left to the schema default — a Google signup cannot ask to be
      // an admin any more than a password signup can.
      user = await User.create({
        email: profile.email,
        name: profile.name,
        firstName: firstName ?? "",
        lastName: rest.join(" "),
        googleId: profile.sub,
        avatarUrl: profile.picture,
      });
      created = true;
      welcomeInBackground(user.email, user.name);
    } else if (!user.googleId) {
      // An existing password account linking Google for the first time. The
      // avatar is only filled in if empty, so a picture the user chose here is
      // not overwritten by their Google one.
      user.googleId = profile.sub;
      if (!user.avatarUrl) user.avatarUrl = profile.picture;
      await user.save();
    }

    const token = signToken(user.id);
    res.status(created ? 201 : 200).json({ token, user: await publicUser(user), created });
  } catch (e) {
    console.error("[auth] google sign-in failed:", e instanceof Error ? e.message : e);
    res.status(500).json({ error: "Google sign-in failed" });
  }
});

router.get("/me", requireAuth, async (req: AuthedRequest, res: Response) => {
  // The demo user has no database record, so a refresh restores it from the
  // token alone rather than looking up an id that intentionally matches nothing.
  if (req.isDemo) return res.json(demoUser());

  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: "not found" });
  res.json({
    ...(await publicUser(user)),
    // Survives a refresh, so the "you are viewing as …" banner can come back.
    impersonating: Boolean(req.impersonatorId),
    // Lets the client switch to its read-only demo behaviour after a reload.
    demo: Boolean(req.isDemo),
  });
});


function clientIp(req: Request): string {
  const raw = req.ip ?? req.socket.remoteAddress ?? "";
  return raw.replace(/^::ffff:/, "") || "unknown";
}

router.post("/demo", async (req: Request, res: Response) => {
  try {
    const limit = await getDemoDailyLimit();
    const attempt = await tryStartDemo(clientIp(req), limit);

    if (!attempt.allowed) {
      const seconds = Math.max(1, Math.ceil((attempt.retryAt.getTime() - Date.now()) / 1000));
      res.set("Retry-After", String(seconds));
      return res.status(429).json({
        error: `You've started the demo ${limit} times today. Please try again later.`,
        retryAt: attempt.retryAt.toISOString(),
        limit,
      });
    }

    res.json({ token: signDemoToken(DEMO_USER_ID), user: demoUser() });
  } catch {
    res.status(500).json({ error: "could not start demo" });
  }
});


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

    // Pointing the avatar somewhere else abandons any file we uploaded for it,
    // so that file goes too. Best-effort: an orphan in Cloudinary is not worth
    // failing a profile save over.
    if (user.avatarPublicId && url !== user.avatarUrl) {
      void deleteImage(user.avatarPublicId);
      user.avatarPublicId = "";
    }
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
  res.json(await publicUser(user));
});


router.post("/me/password", requireAuth, blockDemoWrites, async (req: AuthedRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "not found" });

    const currentPassword = String(req.body?.currentPassword ?? "");
    const newPassword = String(req.body?.newPassword ?? "");

    if (user.passwordHash) {
      if (!currentPassword) return res.status(400).json({ error: "current password required" });
      const ok = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!ok) return res.status(401).json({ error: "current password is incorrect" });
    }

    const invalid = passwordError(newPassword);
    if (invalid) return res.status(400).json({ error: invalid });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();

    await emitTo({
      type: "security.alert",
      userId: String(user._id),
      data: { what: "Your password was changed.", event: "password.changed" },
      link: "/app/settings",
    });

    sendPasswordChangedEmail({ email: user.email, name: user.name }).catch((e) =>
      console.error("[change-password] notice failed:", (e as Error)?.message)
    );

    res.json(await publicUser(user));
  } catch {
    res.status(500).json({ error: "could not update the password" });
  }
});

/** Avatars are 200x200 on delivery, so there is no reason to accept a poster. */
const MAX_AVATAR_BYTES = 3 * 1024 * 1024;


router.post("/me/avatar", requireAuth, blockDemoWrites, async (req: AuthedRequest, res: Response) => {
  try {
    if (!cloudinaryConfigured())
      return res.status(503).json({ error: "image uploads are not configured" });

    const dataUrl = String(req.body?.file ?? "");
    if (!dataUrl) return res.status(400).json({ error: "file required" });

    const checked = checkImageDataUrl(dataUrl, MAX_AVATAR_BYTES);
    if ("error" in checked) return res.status(400).json({ error: checked.error });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "not found" });

    const previousId = user.avatarPublicId;

    const { url, publicId } = await uploadImage({
      file: dataUrl,
      folder: "quantalog-avatars",
      // The timestamp makes each upload a new asset rather than an overwrite, so
      // a CDN or browser holding the old URL never serves the old picture.
      publicId: `avatar-${user.id}-${Date.now()}`,

      transformation: "c_limit,h_200,w_200/q_auto",
    });

    user.avatarUrl = url;
    user.avatarPublicId = publicId;
    await user.save();

    // Only once the replacement is safely stored. Best-effort, as ever.
    if (previousId) void deleteImage(previousId);

    res.json(await publicUser(user));
  } catch (e) {
    console.error("[auth] avatar upload failed:", e instanceof Error ? e.message : e);
    res.status(500).json({ error: "could not upload that image" });
  }
});

/** Remove the profile picture, deleting the uploaded file if there was one. */
router.delete("/me/avatar", requireAuth, blockDemoWrites, async (req: AuthedRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "not found" });

    const previousId = user.avatarPublicId;
    user.avatarUrl = "";
    user.avatarPublicId = "";
    await user.save();

    if (previousId) void deleteImage(previousId);

    res.json(await publicUser(user));
  } catch {
    res.status(500).json({ error: "could not remove the image" });
  }
});


function passwordError(password: string): string | null {
  if (password.length < 8) return "password must be at least 8 characters";
  if (password.length > 72) return "password must be 72 characters or fewer";
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
    return "password must contain at least one letter and one number";
  return null;
}

router.post("/forgot-password", async (req, res) => {
  const accepted = { pending: true, expiresInMinutes: OTP_TTL_MINUTES };

  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "email required" });

    const user = await User.findOne({ email });

    // Unknown address, or a Google-only account with no password to reset.
    // Both answer exactly like the success case.
    if (!user || !user.passwordHash) {
      if (user && !user.passwordHash) {
        // The real owner is told, over email, that there is nothing to reset —
        // where an enumerating caller cannot read it.
        try {
          await sendOne(
            { email, name: user.name },
            "About your Quantalog password",
            `Hi ${user.name},\n\nSomeone asked to reset the password on your Quantalog account, but this account signs in with Google — there is no password to reset.\n\nUse "Continue with Google" on the login page and you're in.\n\nIf this wasn't you, nothing about your account has changed.`,
          );
        } catch {
          console.warn(`[reset] could not send google-account notice to ${email}`);
        }
      }
      return res.status(202).json(accepted);
    }

    if (!mailConfigured()) {
      return res.status(503).json({
        error: "password reset is unavailable right now — please try again later",
      });
    }

    // Spacing applies before a new record replaces the old one, otherwise
    // repeat requests would be an unmetered way to flood someone's inbox.
    const existing = await PasswordReset.findOne({ userId: user._id });
    if (existing) {
      const since = Date.now() - new Date(existing.lastSentAt).getTime();
      if (since < OTP_RESEND_GAP_MS) {
        // Still 202: a caller must not learn from timing or status that the
        // address is registered.
        return res.status(202).json(accepted);
      }
      if (existing.sends >= OTP_MAX_SENDS) {
        return res.status(202).json(accepted);
      }
    }

    const code = generateOtp();
    const codeHash = await bcrypt.hash(code, 10);

    await PasswordReset.findOneAndUpdate(
      { userId: user._id },
      {
        userId: user._id,
        email,
        codeHash,
        expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
        attempts: 0,
        sends: (existing?.sends ?? 0) + 1,
        lastSentAt: new Date(),
        // Not reset on resend: the TTL is keyed off `createdAt` precisely so a
        // stream of resends cannot keep one record alive forever.
        ...(existing ? {} : { createdAt: new Date() }),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    try {
      await sendResetEmail({ email, name: user.name }, code, OTP_TTL_MINUTES);
    } catch (e) {
      await PasswordReset.deleteOne({ userId: user._id });
      console.error("[reset] code send failed:", e instanceof Error ? e.message : e);
      // Still 202 — a mail failure is ours, and reporting it differently would
      // confirm the address exists.
      return res.status(202).json(accepted);
    }

    res.status(202).json(accepted);
  } catch {
    // Even an unexpected failure answers the same shape, for the same reason.
    res.status(202).json(accepted);
  }
});


router.post("/reset-password", async (req, res) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const code = String(req.body?.code ?? "").trim();
    const password = String(req.body?.password ?? "");

    if (!email || !code || !password)
      return res.status(400).json({ error: "email, code and password required" });
    if (!/^\d{6}$/.test(code))
      return res.status(400).json({ error: "enter the 6-digit code" });

    const invalid = passwordError(password);
    if (invalid) return res.status(400).json({ error: invalid });

    const user = await User.findOne({ email });
    const pending = user ? await PasswordReset.findOne({ userId: user._id }) : null;

    // Past this point the caller has produced a code, so they are no longer a
    // blind enumerator — but the message still says nothing about whether the
    // address exists, only that this attempt cannot proceed.
    if (!user || !pending) {
      return res.status(400).json({
        error: "that reset request is no longer valid — start again to get a new code",
        restart: true,
      });
    }

    if (pending.expiresAt.getTime() < Date.now()) {
      await pending.deleteOne();
      return res.status(400).json({
        error: "that code has expired — start again to get a new one",
        restart: true,
      });
    }

    const ok = await bcrypt.compare(code, pending.codeHash);
    if (!ok) {
      pending.attempts += 1;
      if (pending.attempts >= OTP_MAX_ATTEMPTS) {
        await pending.deleteOne();
        return res.status(429).json({
          error: "too many incorrect codes — start again to get a new one",
          restart: true,
        });
      }
      await pending.save();
      return res.status(400).json({
        error: "that code isn't right",
        attemptsLeft: OTP_MAX_ATTEMPTS - pending.attempts,
      });
    }

    user.passwordHash = await bcrypt.hash(password, 10);
    await user.save();
    await pending.deleteOne();

    await emitTo({
      type: "security.alert",
      userId: String(user._id),
      data: { what: "Your password was reset.", event: "password.reset" },
      link: "/app/settings",
    });

    sendPasswordChangedEmail({ email: user.email, name: user.name }).catch((e) =>
      console.error("[reset] change notice failed:", (e as Error)?.message)
    );

 
    const token = signToken(user.id);
    res.json({ token, user: await publicUser(user) });
  } catch {
    res.status(500).json({ error: "could not reset the password" });
  }
});



router.post("/forgot-password/resend", async (req, res) => {
  const accepted = { pending: true, expiresInMinutes: OTP_TTL_MINUTES };

  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "email required" });

    const user = await User.findOne({ email });
    const pending = user ? await PasswordReset.findOne({ userId: user._id }) : null;
    if (!user || !pending) return res.status(202).json(accepted);

    const since = Date.now() - new Date(pending.lastSentAt).getTime();
    if (since < OTP_RESEND_GAP_MS) {
      const seconds = Math.ceil((OTP_RESEND_GAP_MS - since) / 1000);
      res.set("Retry-After", String(seconds));
      return res.status(429).json({
        error: `please wait ${seconds}s before asking for another code`,
        retryInSeconds: seconds,
      });
    }

    if (pending.sends >= OTP_MAX_SENDS) {
      await pending.deleteOne();
      return res.status(429).json({
        error: "too many codes requested — start again in a little while",
        restart: true,
      });
    }

    const code = generateOtp();
    pending.codeHash = await bcrypt.hash(code, 10);
    pending.expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
    // A resend inherits a fresh attempt budget; otherwise the new code would
    // fail for a reason the user cannot see.
    pending.attempts = 0;
    pending.sends += 1;
    pending.lastSentAt = new Date();
    await pending.save();

    try {
      await sendResetEmail({ email, name: user.name }, code, OTP_TTL_MINUTES);
    } catch (e) {
      console.error("[reset] resend failed:", e instanceof Error ? e.message : e);
    }

    res.status(202).json(accepted);
  } catch {
    res.status(202).json(accepted);
  }
});

export default router;
