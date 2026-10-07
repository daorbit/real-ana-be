import { AppSetting, SETTING_REFERRAL_PROGRAM } from "../../config/AppSetting.js";

export const QUALIFY_ON = ["signup", "first_payment"] as const;
export type QualifyOn = (typeof QUALIFY_ON)[number];

export type ReferralSettings = {
  enabled: boolean;
  qualifyOn: QualifyOn;
  rewardPercentOff: number;
  rewardValidDays: number;
  maxRewardsPerUser: number;
};

export const DEFAULT_REFERRAL_SETTINGS: ReferralSettings = {
  enabled: true,
  qualifyOn: "signup",
  rewardPercentOff: 20,
  rewardValidDays: 90,
  maxRewardsPerUser: 0,
};

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
};

export function readReferralSettings(raw: unknown, base = DEFAULT_REFERRAL_SETTINGS): ReferralSettings {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : base.enabled,
    qualifyOn: QUALIFY_ON.includes(input.qualifyOn as QualifyOn) ? (input.qualifyOn as QualifyOn) : base.qualifyOn,
    rewardPercentOff: clampInt(input.rewardPercentOff, 1, 100, base.rewardPercentOff),
    rewardValidDays: clampInt(input.rewardValidDays, 1, 3650, base.rewardValidDays),
    maxRewardsPerUser: clampInt(input.maxRewardsPerUser, 0, 10000, base.maxRewardsPerUser),
  };
}

export async function getReferralSettings(): Promise<ReferralSettings> {
  const row = await AppSetting.findOne({ key: SETTING_REFERRAL_PROGRAM });
  return readReferralSettings(row?.get("value"));
}

export async function setReferralSettings(patch: unknown): Promise<ReferralSettings> {
  const next = readReferralSettings(patch, await getReferralSettings());
  await AppSetting.updateOne(
    { key: SETTING_REFERRAL_PROGRAM },
    { $set: { value: next } },
    { upsert: true }
  );
  return next;
}
