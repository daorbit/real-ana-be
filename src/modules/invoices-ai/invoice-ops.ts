export const MAX_OPS = 60;

export interface ClientPatch {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  gstin?: string;
}

export interface ItemPatch {
  description?: string;
  quantity?: number;
  rate?: number;
  unit?: string;
  hsn?: string;
  taxRate?: number;
}

export interface DocumentPatch {
  currency?: string;
  issueDate?: string;
  dueDate?: string;
  dueInDays?: number;
  reference?: string;
  discount?: number;
  discountType?: "percentage" | "fixed";
  shipping?: number;
  amountPaid?: number;
  notes?: string;
  terms?: string;
  taxRate?: number;
  pricesIncludeTax?: boolean;
}

export type InvoiceOp =
  | { op: "setClient"; patch: ClientPatch }
  | { op: "addItem"; item: ItemPatch & { description: string } }
  | { op: "updateItem"; id: string; patch: ItemPatch }
  | { op: "removeItem"; id: string }
  | { op: "setDocument"; patch: DocumentPatch };

export interface OpRules {
  rates: number[];
  itemIds?: Set<string>;
}

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function amount(value: unknown, max = 1_000_000_000): number | undefined {
  const parsed = typeof value === "string" ? Number(value.replace(/[^\d.-]/g, "")) : Number(value);
  if (value === null || value === "" || !Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.min(max, Math.round(parsed * 1000) / 1000);
}

function isoDate(value: unknown): string | undefined {
  const raw = text(value, 10);
  if (!raw || !ISO_DATE.test(raw)) return undefined;
  return Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime()) ? undefined : raw;
}

function hsn(value: unknown): string | undefined {
  const digits = typeof value === "string" || typeof value === "number" ? String(value).replace(/\D/g, "") : "";
  return digits.length >= 4 && digits.length <= 8 ? digits : undefined;
}

function taxRate(value: unknown, rates: number[]): number | undefined {
  const rate = amount(typeof value === "string" ? value.replace("%", "") : value, 100);
  return rate !== undefined && rates.includes(rate) ? rate : undefined;
}

function currency(value: unknown): string | undefined {
  const code = text(value, 3)?.toUpperCase();
  return code && /^[A-Z]{3}$/.test(code) ? code : undefined;
}

function compact<T extends object>(patch: T): T | null {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  return entries.length ? (Object.fromEntries(entries) as T) : null;
}

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function readClientPatch(raw: unknown): ClientPatch | null {
  const r = record(raw);
  const gstin = text(r.gstin, 15)?.toUpperCase();
  return compact<ClientPatch>({
    name: text(r.name, 200),
    email: text(r.email, 200),
    phone: text(r.phone, 50),
    address: text(r.address, 500),
    gstin: gstin && GSTIN.test(gstin) ? gstin : undefined,
  });
}

export function readItemPatch(raw: unknown, rates: number[]): ItemPatch | null {
  const r = record(raw);
  return compact<ItemPatch>({
    description: text(r.description, 500),
    quantity: amount(r.quantity, 1_000_000),
    rate: amount(r.rate),
    unit: text(r.unit, 16),
    hsn: hsn(r.hsn),
    taxRate: taxRate(r.taxRate, rates),
  });
}

export function readDocumentPatch(raw: unknown, rates: number[]): DocumentPatch | null {
  const r = record(raw);
  const days = amount(r.dueInDays, 365);
  const discountType = r.discountType === "percentage" || r.discountType === "fixed" ? r.discountType : undefined;
  return compact<DocumentPatch>({
    currency: currency(r.currency),
    issueDate: isoDate(r.issueDate),
    dueDate: isoDate(r.dueDate),
    dueInDays: days === undefined ? undefined : Math.round(days),
    reference: text(r.reference, 64),
    discount: amount(r.discount),
    discountType,
    shipping: amount(r.shipping),
    amountPaid: amount(r.amountPaid),
    notes: text(r.notes, 2000),
    terms: text(r.terms, 2000),
    taxRate: taxRate(r.taxRate, rates),
    pricesIncludeTax: typeof r.pricesIncludeTax === "boolean" ? r.pricesIncludeTax : undefined,
  });
}

function readOp(raw: unknown, rules: OpRules): InvoiceOp | null {
  const r = record(raw);
  const id = text(r.id, 100);
  const known = (value: string | undefined): value is string => Boolean(value && rules.itemIds?.has(value));

  switch (r.op) {
    case "setClient": {
      const patch = readClientPatch(r.patch);
      return patch ? { op: "setClient", patch } : null;
    }
    case "addItem": {
      const item = readItemPatch(r.item, rules.rates);
      return item?.description ? { op: "addItem", item: { ...item, description: item.description } } : null;
    }
    case "updateItem": {
      const patch = readItemPatch(r.patch, rules.rates);
      return known(id) && patch ? { op: "updateItem", id, patch } : null;
    }
    case "removeItem":
      return known(id) ? { op: "removeItem", id } : null;
    case "setDocument": {
      const patch = readDocumentPatch(r.patch, rules.rates);
      return patch ? { op: "setDocument", patch } : null;
    }
    default:
      return null;
  }
}

function significantWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
}

function promptNames(prompt: string, label: string | undefined): boolean {
  if (!label) return true;
  const words = significantWords(label);
  if (!words.length) return true;
  const asked = new Set(significantWords(prompt));
  return words.some((word) => asked.has(word)) || /\b(all|every|clear|remove all|empty)\b/i.test(prompt);
}

export type ParseOpsResult = { ok: true; ops: InvoiceOp[] } | { ok: false; reason: string };

export function parseInvoiceOps(
  raw: unknown,
  rules: OpRules,
  guard?: { prompt: string; labels: Map<string, string> },
): ParseOpsResult {
  const list = Array.isArray(raw) ? raw : Array.isArray(record(raw).ops) ? (record(raw).ops as unknown[]) : null;
  if (!list) return { ok: false, reason: "no operations" };

  const ops = list
    .slice(0, MAX_OPS)
    .map((entry) => readOp(entry, rules))
    .filter((entry): entry is InvoiceOp => entry !== null)
    .filter((entry) => !guard || entry.op !== "removeItem" || promptNames(guard.prompt, guard.labels.get(entry.id)));

  return ops.length ? { ok: true, ops } : { ok: false, reason: "no usable operations" };
}
