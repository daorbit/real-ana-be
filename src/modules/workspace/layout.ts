export type Placed = { id: string; span: number };

export const MAX_WIDGETS = 50;

export function parseLayout(body: unknown): Placed[] | null {
  if (!Array.isArray(body) || body.length > MAX_WIDGETS) return null;
  const out: Placed[] = [];
  for (const item of body) {
    const id = (item as Placed)?.id;
    const span = (item as Placed)?.span;
    if (typeof id !== "string" || !id || id.length > 64) return null;
    if (![1, 2, 3, 4].includes(span)) return null;
    out.push({ id, span });
  }
  return out;
}
