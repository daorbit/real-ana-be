export const ALERT_RULES = ["trafficDrop", "trafficSpike", "trackingStopped", "goalBehind", "formsQuiet"] as const;
export type AlertRule = (typeof ALERT_RULES)[number];

export const ALERT_CHANNELS = ["email", "telegram", "whatsapp"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

type RuleSpec = { unit: "percent" | "hours" | "days"; min: number; max: number; value: number; enabled: boolean };

export const RULE_SPECS: Record<AlertRule, RuleSpec> = {
  trafficDrop: { unit: "percent", min: 10, max: 95, value: 40, enabled: true },
  trafficSpike: { unit: "percent", min: 25, max: 1000, value: 100, enabled: true },
  trackingStopped: { unit: "hours", min: 1, max: 72, value: 6, enabled: true },
  goalBehind: { unit: "percent", min: 5, max: 90, value: 20, enabled: true },
  formsQuiet: { unit: "days", min: 1, max: 30, value: 3, enabled: false },
};

export type RuleConfig = { enabled: boolean; value: number };

export type AlertConfig = {
  rules: Record<AlertRule, RuleConfig>;
  channels: Record<AlertChannel, boolean>;
};

const DEFAULT_CHANNELS: Record<AlertChannel, boolean> = { email: true, telegram: false, whatsapp: false };

export function defaultConfig(): AlertConfig {
  return {
    rules: Object.fromEntries(
      ALERT_RULES.map((rule) => [rule, { enabled: RULE_SPECS[rule].enabled, value: RULE_SPECS[rule].value }]),
    ) as Record<AlertRule, RuleConfig>,
    channels: { ...DEFAULT_CHANNELS },
  };
}

function parseRule(rule: AlertRule, raw: unknown, current: RuleConfig): RuleConfig | string {
  if (raw === undefined) return current;
  if (!raw || typeof raw !== "object") return `${rule} must be an object`;
  const input = raw as Record<string, unknown>;
  const spec = RULE_SPECS[rule];
  const enabled = input.enabled === undefined ? current.enabled : Boolean(input.enabled);
  const value = input.value === undefined ? current.value : Number(input.value);
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
    return `${rule} must be between ${spec.min} and ${spec.max}`;
  }
  return { enabled, value: Math.round(value) };
}

export function parseConfig(body: unknown, current: AlertConfig): AlertConfig | string {
  const input = (body ?? {}) as { rules?: Record<string, unknown>; channels?: Record<string, unknown> };
  const rules = { ...current.rules };
  for (const rule of ALERT_RULES) {
    const parsed = parseRule(rule, input.rules?.[rule], current.rules[rule]);
    if (typeof parsed === "string") return parsed;
    rules[rule] = parsed;
  }
  const channels = { ...current.channels };
  for (const channel of ALERT_CHANNELS) {
    const raw = input.channels?.[channel];
    if (raw !== undefined) channels[channel] = Boolean(raw);
  }
  return { rules, channels };
}
