import { askJson, invoicesAiReady } from "./ask-model.js";
import { readItemPatch, type InvoiceOp } from "./invoice-ops.js";
import { GST_RATES, type InvoiceSnapshot } from "./invoice-input.js";
import type { InvoiceAiResult } from "./draft.js";

const MAX_TOKENS = 1500;

const SYSTEM_PROMPT = [
  "You are an Indian GST assistant. For each invoice item, give the most likely HSN code (goods) or SAC code (services) and the GST rate that applies to it.",
  'Reply with one JSON object {"items": [{"id": string, "hsn": string, "taxRate": number}]} and nothing else.',
  "",
  "Rules:",
  "- Use the item ids exactly as given. One entry per item you are reasonably sure about; skip items you cannot classify.",
  "- HSN/SAC codes are 4 to 8 digits. Services use SAC codes starting with 99.",
  `- "taxRate" must be one of: ${GST_RATES.join(", ")}.`,
].join("\n");

const EXAMPLE_USER = "line-1 | Website design and development\nline-2 | Printed brochures, A4";
const EXAMPLE_REPLY = JSON.stringify({
  items: [
    { id: "line-1", hsn: "998314", taxRate: 18 },
    { id: "line-2", hsn: "4911", taxRate: 12 },
  ],
});

function readSuggestions(raw: unknown, snapshot: InvoiceSnapshot): InvoiceOp[] | null {
  const list = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).items)
    ? ((raw as Record<string, unknown>).items as unknown[])
    : null;
  if (!list) return null;

  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  const ops: InvoiceOp[] = [];

  for (const entry of list) {
    const id = entry && typeof entry === "object" ? String((entry as Record<string, unknown>).id ?? "") : "";
    const current = byId.get(id);
    const patch = readItemPatch(entry, GST_RATES);
    if (!current || !patch) continue;
    const change = {
      ...(patch.hsn && patch.hsn !== current.hsn ? { hsn: patch.hsn } : {}),
      ...(patch.taxRate !== undefined && patch.taxRate !== current.taxRate ? { taxRate: patch.taxRate } : {}),
    };
    if (Object.keys(change).length) ops.push({ op: "updateItem", id, patch: change });
  }

  return ops;
}

export async function suggestGst(snapshot: InvoiceSnapshot): Promise<InvoiceAiResult> {
  if (!invoicesAiReady()) return { ok: false, status: 503, error: "Orbit is not set up on this server." };

  const items = snapshot.items.filter((item) => item.description);
  if (!items.length) return { ok: false, status: 400, error: "Add an item first, then ask Orbit about GST." };

  const answer = await askJson(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: EXAMPLE_USER },
      { role: "assistant", content: EXAMPLE_REPLY },
      { role: "user", content: items.map((item) => `${item.id} | ${item.description}${item.unit ? ` (${item.unit})` : ""}`).join("\n") },
    ],
    (raw) => readSuggestions(raw, snapshot),
    MAX_TOKENS,
  );

  if (!answer.ok) {
    console.error("[invoices-ai] gst failed —", answer.detail);
    return { ok: false, status: 502, error: "Orbit could not suggest GST codes for these items." };
  }

  const count = answer.value.length;
  const summary = count
    ? `Suggested HSN/SAC codes and GST rates for ${count} ${count === 1 ? "item" : "items"}. Check them before you send.`
    : "The codes and rates already look right.";

  return { ok: true, ops: answer.value, summary, model: answer.model };
}
