import mongoose, { Schema } from "mongoose";

/**
 * A tiny key/value store for settings an admin can change at runtime.
 *
 * Deliberately generic and deliberately small: things that belong in the
 * environment (secrets, connection strings) stay there. This is for operational
 * knobs the person running the product should be able to turn without a deploy
 * — currently just the per-IP demo limit.
 */
const appSettingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: Schema.Types.Mixed },
  },
  { timestamps: true, versionKey: false }
);

export const AppSetting = mongoose.model("AppSetting", appSettingSchema);

/** Settings keys, named once so a typo can't silently create a second row. */
export const SETTING_DEMO_DAILY_LIMIT = "demo.dailyLimitPerIp";

/** How many demo sessions one address may start per day before being refused. */
export const DEFAULT_DEMO_DAILY_LIMIT = 3;

export async function getDemoDailyLimit(): Promise<number> {
  const row = await AppSetting.findOne({ key: SETTING_DEMO_DAILY_LIMIT });
  const value = Number(row?.get("value"));
  // A missing or nonsensical stored value falls back to the default rather than
  // accidentally disabling the limit.
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_DEMO_DAILY_LIMIT;
}

export async function setDemoDailyLimit(limit: number): Promise<number> {
  const clean = Math.max(1, Math.min(1000, Math.floor(limit)));
  await AppSetting.updateOne(
    { key: SETTING_DEMO_DAILY_LIMIT },
    { $set: { value: clean } },
    { upsert: true }
  );
  return clean;
}
