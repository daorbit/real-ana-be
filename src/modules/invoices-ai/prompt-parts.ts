import type { InvoiceContext, InvoiceSnapshot } from "./invoice-input.js";

export function contextBlock(context: InvoiceContext): string {
  const catalog = context.catalog.length
    ? context.catalog
        .map((entry) =>
          `- ${entry.name} | rate ${entry.rate}${entry.unit ? ` per ${entry.unit}` : ""}${entry.hsn ? ` | HSN/SAC ${entry.hsn}` : ""} | tax ${entry.taxRate}%`,
        )
        .join("\n")
    : "(none saved)";

  return [
    `Document: ${context.kind}. Currency: ${context.currency}. Today: ${context.today}.`,
    context.gst
      ? "The seller is GST-registered in India, so every item needs a GST rate and an HSN (goods) or SAC (services) code."
      : "The seller is not issuing a GST tax invoice.",
    `Allowed tax rates: ${context.taxRates.join(", ")}.`,
    `Default payment terms: ${context.paymentTermsDays} days.`,
    "Saved items (reuse the exact name when the request means one of these):",
    catalog,
    `Saved customers: ${context.customers.length ? context.customers.join(", ") : "(none saved)"}.`,
  ].join("\n");
}

export function snapshotBlock(snapshot: InvoiceSnapshot): string {
  const items = snapshot.items.length
    ? snapshot.items
        .map(
          (item) =>
            `${item.id} | ${item.description || "(no description)"} | qty ${item.quantity}${item.unit ? ` ${item.unit}` : ""} | rate ${item.rate} | tax ${item.taxRate}%${item.hsn ? ` | HSN/SAC ${item.hsn}` : ""}`,
        )
        .join("\n")
    : "(no items)";

  const client = [snapshot.client.name, snapshot.client.email, snapshot.client.gstin].filter(Boolean).join(" | ");

  return [
    `Client: ${client || "(none)"}`,
    `Currency: ${snapshot.currency}. Issued: ${snapshot.issueDate || "-"}. Due: ${snapshot.dueDate || "-"}.`,
    `Discount: ${snapshot.discount} (${snapshot.discountType}). Shipping: ${snapshot.shipping}. Already paid: ${snapshot.amountPaid}.`,
    `Reference: ${snapshot.reference || "-"}`,
    `Notes: ${snapshot.notes || "-"}`,
    `Terms: ${snapshot.terms || "-"}`,
    "Items (id | description | quantity | rate | tax | code):",
    items,
  ].join("\n");
}
