export const MAX_FIELDS = 12;
const MAX_VALUE = 300;

export type FormAlert = { title: string; answers: { label: string; value: string }[] };

export function clip(value: string): string {
  return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value;
}

export function parseFormAlert(body: unknown): FormAlert | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 200) : "";
  if (!title) return null;
  const answers = (Array.isArray(raw.answers) ? raw.answers : [])
    .map((a) => {
      if (!a || typeof a !== "object") return null;
      const row = a as Record<string, unknown>;
      const label = typeof row.label === "string" ? row.label.slice(0, 120) : "";
      const value = typeof row.value === "string" ? row.value.slice(0, 500) : "";
      return label ? { label, value } : null;
    })
    .filter((a): a is { label: string; value: string } => a !== null)
    .slice(0, MAX_FIELDS);
  return { title, answers };
}
