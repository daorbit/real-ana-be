import type { Signal } from "./types.js";

const MORE_SPECIFIC: { keep: string; drop: string; note: string }[] = [
  {
    keep: "bookingDecline",
    drop: "formRateDecline",
    note: "The same form also turns fewer views into responses. That is part of this finding, not a separate one.",
  },
];

function keyOf(signal: Signal): string {
  return signal.fingerprint.slice(signal.detector.length + 1);
}

export function groupSignals(signals: Signal[]): Signal[] {
  const byFingerprint = new Map<string, Signal>();
  for (const signal of signals) byFingerprint.set(signal.fingerprint, signal);

  for (const rule of MORE_SPECIFIC) {
    for (const signal of [...byFingerprint.values()]) {
      if (signal.detector !== rule.drop) continue;
      const keeper = byFingerprint.get(`${rule.keep}:${keyOf(signal)}`);
      if (!keeper) continue;
      byFingerprint.delete(signal.fingerprint);
      byFingerprint.set(keeper.fingerprint, { ...keeper, limitations: [...keeper.limitations, rule.note] });
    }
  }

  return [...byFingerprint.values()];
}
