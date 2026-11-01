export const MIN_SESSIONS = 100;
export const SIGNIFICANT = 0.95;

export type VariantCounts = { key: string; name: string; sessions: number; conversions: number };

export type VariantResult = VariantCounts & {
  rate: number;
  uplift: number | null;
  confidence: number | null;
};

export type ResultsSummary = {
  variants: VariantResult[];
  totalSessions: number;
  leader: string | null;
  winner: string | null;
  enoughData: boolean;
};

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export function rateOf(counts: Pick<VariantCounts, "sessions" | "conversions">): number {
  return counts.sessions > 0 ? counts.conversions / counts.sessions : 0;
}

export function chanceToBeat(control: VariantCounts, variant: VariantCounts): number | null {
  if (!control.sessions || !variant.sessions) return null;
  const p1 = rateOf(control);
  const p2 = rateOf(variant);
  const pooled = (control.conversions + variant.conversions) / (control.sessions + variant.sessions);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / control.sessions + 1 / variant.sessions));
  if (!se) return p2 === p1 ? 0.5 : p2 > p1 ? 1 : 0;
  return normalCdf((p2 - p1) / se);
}

export function summarize(counts: VariantCounts[]): ResultsSummary {
  const [control] = counts;
  const variants: VariantResult[] = counts.map((c, i) => {
    const rate = rateOf(c);
    if (i === 0 || !control) return { ...c, rate, uplift: null, confidence: null };
    const base = rateOf(control);
    return { ...c, rate, uplift: base > 0 ? (rate - base) / base : null, confidence: chanceToBeat(control, c) };
  });

  const totalSessions = counts.reduce((sum, c) => sum + c.sessions, 0);
  const enoughData = counts.length > 1 && counts.every((c) => c.sessions >= MIN_SESSIONS);
  const ranked = [...variants].filter((v) => v.sessions > 0).sort((a, b) => b.rate - a.rate);
  const leader = ranked[0]?.key ?? null;

  let winner: string | null = null;
  if (enoughData) {
    const challengers = variants.slice(1);
    const best = challengers.filter((v) => (v.confidence ?? 0) >= SIGNIFICANT).sort((a, b) => b.rate - a.rate)[0];
    if (best) winner = best.key;
    else if (challengers.every((v) => v.confidence !== null && v.confidence <= 1 - SIGNIFICANT)) winner = variants[0].key;
  }

  return { variants, totalSessions, leader, winner, enoughData };
}
