import { askJson, invoicesAiReady } from "./ask-model.js";
import { parseInvoiceOps, type InvoiceOp } from "./invoice-ops.js";
import type { InvoiceContext, InvoiceSnapshot } from "./invoice-input.js";
import { contextBlock, snapshotBlock } from "./prompt-parts.js";
import { summarizeOps } from "./summary.js";
import { MAX_PROMPT_CHARS, type InvoiceAiResult } from "./draft.js";

const MAX_TOKENS = 2000;

const EXAMPLE_SNAPSHOT = "Items (id | description | quantity | rate | tax | code):\nline-1 | Logo design | qty 1 | rate 12000 | tax 18%";
const EXAMPLE_USER = "add 2 hours of support at 1500 and give 10% off";
const EXAMPLE_REPLY = JSON.stringify({
  ops: [
    { op: "addItem", item: { description: "Support", quantity: 2, unit: "hours", rate: 1500, taxRate: 18 } },
    { op: "setDocument", patch: { discount: 10, discountType: "percentage" } },
  ],
});

function systemPrompt(context: InvoiceContext): string {
  return [
    `You change an existing ${context.kind}. You reply with one JSON object {"ops": [...]} and nothing else.`,
    "",
    "Operations:",
    '- {"op": "setClient", "patch": {"name", "email", "phone", "address", "gstin"}}',
    '- {"op": "addItem", "item": {"description", "quantity", "unit", "rate", "taxRate", "hsn"}}',
    '- {"op": "updateItem", "id": "<item id>", "patch": {"description", "quantity", "unit", "rate", "taxRate", "hsn"}}',
    '- {"op": "removeItem", "id": "<item id>"}',
    '- {"op": "setDocument", "patch": {"currency", "issueDate", "dueDate", "dueInDays", "reference", "discount", "discountType", "shipping", "amountPaid", "notes", "terms", "taxRate", "pricesIncludeTax"}}',
    "",
    "Rules:",
    "- Return only what the request asks to change. Everything else stays as it is, so never repeat unchanged items.",
    "- Refer to items by the id shown in the table. Never invent an id.",
    "- Numbers are plain numbers without currency symbols or commas. Dates are YYYY-MM-DD.",
    '- "discountType" is "percentage" for "10% off" and "fixed" for an amount off.',
    '- "taxRate" on setDocument applies one rate to every item. It must be one of the allowed tax rates.',
    "- When asked to write notes or terms, write them in full, short and plain.",
    "",
    contextBlock(context),
  ].join("\n");
}

export async function editInvoice(
  prompt: string,
  snapshot: InvoiceSnapshot,
  context: InvoiceContext,
): Promise<InvoiceAiResult> {
  if (!invoicesAiReady()) return { ok: false, status: 503, error: "Orbit is not set up on this server." };

  const asked = prompt.trim().slice(0, MAX_PROMPT_CHARS);
  if (!asked) return { ok: false, status: 400, error: "Tell Orbit what to change." };

  const itemIds = new Set(snapshot.items.map((item) => item.id));
  const labels = new Map(snapshot.items.map((item) => [item.id, item.description]));
  const read = (raw: unknown): InvoiceOp[] | null => {
    const parsed = parseInvoiceOps(raw, { rates: context.taxRates, itemIds }, { prompt: asked, labels });
    return parsed.ok ? parsed.ops : null;
  };

  const answer = await askJson(
    [
      { role: "system", content: systemPrompt(context) },
      { role: "user", content: `${EXAMPLE_SNAPSHOT}\n\nChange: ${EXAMPLE_USER}` },
      { role: "assistant", content: EXAMPLE_REPLY },
      { role: "user", content: `${snapshotBlock(snapshot)}\n\nChange: ${asked}` },
    ],
    read,
    MAX_TOKENS,
  );

  if (!answer.ok) {
    console.error("[invoices-ai] edit failed —", answer.detail);
    return { ok: false, status: 502, error: "Orbit could not work out that change." };
  }

  return { ok: true, ops: answer.value, summary: summarizeOps(answer.value), model: answer.model };
}
