import { randomInt } from "crypto";
import { ReferralCode } from "./models/ReferralCode.js";
import { User } from "../identity/models/User.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_ATTEMPTS = 5;

export function randomToken(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(0, ALPHABET.length)];
  return out;
}

function prefixFromName(name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);
  return letters.length >= 3 ? letters : "QL";
}

export function normalizeCode(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
}

export async function ensureReferralCode(userId: string) {
  const existing = await ReferralCode.findOne({ userId });
  if (existing) return existing;

  const user = await User.findById(userId).select("name");
  const prefix = prefixFromName(String(user?.name ?? ""));

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await ReferralCode.create({ userId, code: `${prefix}${randomToken(4)}` });
    } catch (e) {
      if (!(e as Error).message?.includes("E11000")) throw e;
      const raced = await ReferralCode.findOne({ userId });
      if (raced) return raced;
    }
  }
  throw new Error("could not generate a referral code");
}
