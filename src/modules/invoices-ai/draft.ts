import { askJson, askVisionJson, invoicesAiReady } from "./ask-model.js";
import { readClientPatch, readDocumentPatch, readItemPatch, type InvoiceOp } from "./invoice-ops.js";
import type { InvoiceContext } from "./invoice-input.js";
import { contextBlock } from "./prompt-parts.js";
import { summarizeOps } from "./summary.js";

export const MAX_PROMPT_CHARS = 1000;
const MAX_ATTACHMENT_TEXT = 12_000;
const MAX_DRAFT_ITEMS = 60;
const MAX_TOKENS = 3000;

export type OrbitAttachment = { image: string } | { text: string } | null;

export type InvoiceAiResult =
  | { ok: true; ops: InvoiceOp[]; summary: string; model: string }
  | { ok: false; status: number; error: string };

const EXAMPLE_USER = "Invoice Acme Pvt Ltd for 3 days of consulting at 8000 a day and a 15000 setup fee, 18% GST, due in 15 days";
const EXAMPLE_REPLY = JSON.stringify({
  client: { name: "Acme Pvt Ltd" },
  items: [
    { description: "Consulting", quantity: 3, unit: "day", rate: 8000, taxRate: 18, hsn: "998311" },
    { description: "Setup fee", quantity: 1, rate: 15000, taxRate: 18, hsn: "998311" },
  ],
  dueInDays: 15,
});

function systemPrompt(context: InvoiceContext): string {
  return [
    `You fill in ${context.kind === "quotation" ? "quotations" : "invoices"} for a small business. You reply with one JSON object and nothing else — no prose, no code fence.`,
    "",
    "Shape:",
    "{",
    '  "client": { "name": string, "email": string, "phone": string, "address": string, "gstin": string },',
    '  "items": [ { "description": string, "quantity": number, "unit": string, "rate": number, "taxRate": number, "hsn": string } ],',
    '  "currency": string, "issueDate": "YYYY-MM-DD", "dueDate": "YYYY-MM-DD", "dueInDays": number, "reference": string,',
    '  "discount": number, "discountType": "percentage" | "fixed", "shipping": number, "amountPaid": number, "notes": string, "terms": string',
    "}",
    "",
    "Rules:",
    "- Only include what the request or the attached document actually says. Leave a key out rather than guess. Never invent emails, phone numbers, addresses or GSTINs.",
    "- Numbers are plain numbers: no currency symbols, no commas. \"rate\" is the price of one unit before tax.",
    '- "quantity" defaults to 1. Put "hours", "day", "pcs" and the like in "unit".',
    '- "taxRate" must be one of the allowed tax rates. Leave it out if the request does not say and you cannot tell.',
    '- For "due in N days" or "Net N", use "dueInDays". Use "dueDate" only for a calendar date.',
    "- When an item is one of the saved items, use its exact name as the description.",
    "- When the client is one of the saved customers, use that exact name.",
    "",
    contextBlock(context),
  ].join("\n");
}

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function toOps(raw: unknown, context: InvoiceContext): InvoiceOp[] | null {
  const r = record(raw);
  const ops: InvoiceOp[] = [];

  const client = readClientPatch(r.client);
  if (client) ops.push({ op: "setClient", patch: client });

  const items = Array.isArray(r.items) ? r.items : [];
  for (const entry of items.slice(0, MAX_DRAFT_ITEMS)) {
    const item = readItemPatch(entry, context.taxRates);
    if (item?.description) ops.push({ op: "addItem", item: { ...item, description: item.description } });
  }

  const document = readDocumentPatch(r, context.taxRates);
  if (document) ops.push({ op: "setDocument", patch: document });

  return ops.length ? ops : null;
}

function withAttachmentText(asked: string, text: string): string {
  return [
    asked || "Create a draft from this document.",
    "",
    "Text read from the attached document:",
    "<<<",
    text.slice(0, MAX_ATTACHMENT_TEXT),
    ">>>",
  ].join("\n");
}

export async function draftInvoice(
  prompt: string,
  context: InvoiceContext,
  attachment: OrbitAttachment,
): Promise<InvoiceAiResult> {
  if (!invoicesAiReady()) return { ok: false, status: 503, error: "Orbit is not set up on this server." };

  const asked = prompt.trim().slice(0, MAX_PROMPT_CHARS);
  if (!asked && !attachment) return { ok: false, status: 400, error: "Tell Orbit what to bill for." };

  const read = (raw: unknown) => toOps(raw, context);

  const answer =
    attachment && "image" in attachment
      ? await askVisionJson(
          [
            systemPrompt(context),
            "",
            `Example — asked "${EXAMPLE_USER}", the reply was:`,
            EXAMPLE_REPLY,
            "",
            "The attached image is a purchase order, quote, bill or old invoice. Read the client and every line item from it, in order.",
            `Request: ${asked || "Create a draft from this image."}`,
            "",
            "Reply with one JSON object in the shape above and nothing else.",
          ].join("\n"),
          attachment.image,
          read,
          MAX_TOKENS,
        )
      : await askJson(
          [
            { role: "system", content: systemPrompt(context) },
            { role: "user", content: EXAMPLE_USER },
            { role: "assistant", content: EXAMPLE_REPLY },
            { role: "user", content: attachment ? withAttachmentText(asked, attachment.text) : asked },
          ],
          read,
          MAX_TOKENS,
        );

  if (!answer.ok) {
    console.error("[invoices-ai] draft failed —", answer.detail);
    return {
      ok: false,
      status: 502,
      error: attachment ? "Orbit could not read a document from that file." : "Orbit could not build a draft from that.",
    };
  }

  return { ok: true, ops: answer.value, summary: summarizeOps(answer.value), model: answer.model };
}
