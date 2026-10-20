const MAX_PROPS_CHARS = 2_000;

export function cleanProps(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  try {
    return JSON.stringify(raw).length <= MAX_PROPS_CHARS ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
