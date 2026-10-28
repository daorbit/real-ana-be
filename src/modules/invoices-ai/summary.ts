import type { InvoiceOp } from "./invoice-ops.js";

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function documentParts(patch: Extract<InvoiceOp, { op: "setDocument" }>["patch"]): string[] {
  const parts: string[] = [];
  if (patch.discount !== undefined) {
    parts.push(`set the discount to ${patch.discount}${patch.discountType === "fixed" ? "" : "%"}`);
  }
  if (patch.dueInDays !== undefined) parts.push(`made it due in ${patch.dueInDays} days`);
  else if (patch.dueDate) parts.push(`set the due date to ${patch.dueDate}`);
  if (patch.issueDate) parts.push(`dated it ${patch.issueDate}`);
  if (patch.taxRate !== undefined) parts.push(`set tax to ${patch.taxRate}% on every item`);
  if (patch.shipping !== undefined) parts.push("set shipping");
  if (patch.amountPaid !== undefined) parts.push("recorded the amount already paid");
  if (patch.currency) parts.push(`switched to ${patch.currency}`);
  if (patch.notes) parts.push("wrote the notes");
  if (patch.terms) parts.push("wrote the terms");
  if (patch.reference) parts.push("added the reference");
  if (patch.pricesIncludeTax !== undefined) parts.push(patch.pricesIncludeTax ? "made prices include tax" : "made prices exclude tax");
  return parts;
}

export function summarizeOps(ops: InvoiceOp[]): string {
  const added = ops.filter((op) => op.op === "addItem").length;
  const updated = ops.filter((op) => op.op === "updateItem").length;
  const removed = ops.filter((op) => op.op === "removeItem").length;
  const client = ops.find((op) => op.op === "setClient");

  const parts = [
    client && client.op === "setClient" && client.patch.name ? `set the client to ${client.patch.name}` : client ? "updated the client" : "",
    added ? `added ${plural(added, "item")}` : "",
    updated ? `changed ${plural(updated, "item")}` : "",
    removed ? `removed ${plural(removed, "item")}` : "",
    ...ops.flatMap((op) => (op.op === "setDocument" ? documentParts(op.patch) : [])),
  ].filter(Boolean);

  if (!parts.length) return "Nothing to change.";
  const sentence = parts.join(", ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
