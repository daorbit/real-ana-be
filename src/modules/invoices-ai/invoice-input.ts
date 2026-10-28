import type { ClientPatch } from "./invoice-ops.js";

export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];
const MAX_CATALOG = 40;
const MAX_CUSTOMERS = 40;
const MAX_ITEMS = 100;

export interface CatalogEntry {
  name: string;
  rate: number;
  unit: string;
  hsn: string;
  taxRate: number;
}

export interface InvoiceContext {
  kind: "invoice" | "quotation";
  currency: string;
  today: string;
  gst: boolean;
  taxRates: number[];
  paymentTermsDays: number;
  catalog: CatalogEntry[];
  customers: string[];
}

export interface SnapshotItem {
  id: string;
  description: string;
  quantity: number;
  rate: number;
  unit: string;
  hsn: string;
  taxRate: number;
}

export interface InvoiceSnapshot {
  client: ClientPatch;
  items: SnapshotItem[];
  currency: string;
  issueDate: string;
  dueDate: string;
  discount: number;
  discountType: string;
  shipping: number;
  amountPaid: number;
  reference: string;
  notes: string;
  terms: string;
}

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rateList(value: unknown): number[] {
  const rates = Array.isArray(value) ? value.map(Number).filter((rate) => Number.isFinite(rate) && rate >= 0 && rate <= 100) : [];
  return rates.length ? [...new Set(rates)].slice(0, 12) : GST_RATES;
}

export function readInvoiceContext(raw: unknown): InvoiceContext | null {
  const r = record(raw);
  const currency = str(r.currency, 3).toUpperCase();
  const today = str(r.today, 10);
  if (!/^[A-Z]{3}$/.test(currency) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;

  const catalog = (Array.isArray(r.catalog) ? r.catalog : [])
    .slice(0, MAX_CATALOG)
    .map((entry) => {
      const e = record(entry);
      return { name: str(e.name, 120), rate: num(e.rate), unit: str(e.unit, 16), hsn: str(e.hsn, 8), taxRate: num(e.taxRate) };
    })
    .filter((entry) => entry.name);

  const customers = (Array.isArray(r.customers) ? r.customers : [])
    .map((name) => str(name, 120))
    .filter(Boolean)
    .slice(0, MAX_CUSTOMERS);

  return {
    kind: r.kind === "quotation" ? "quotation" : "invoice",
    currency,
    today,
    gst: r.gst === true,
    taxRates: rateList(r.taxRates),
    paymentTermsDays: Math.min(365, Math.max(0, Math.round(num(r.paymentTermsDays)))),
    catalog,
    customers,
  };
}

export function readInvoiceSnapshot(raw: unknown): InvoiceSnapshot | null {
  const r = record(raw);
  if (!Array.isArray(r.items)) return null;
  const client = record(r.client);

  const items = r.items
    .slice(0, MAX_ITEMS)
    .map((entry) => {
      const e = record(entry);
      return {
        id: str(e.id, 100),
        description: str(e.description, 500),
        quantity: num(e.quantity),
        rate: num(e.rate),
        unit: str(e.unit, 16),
        hsn: str(e.hsn, 8),
        taxRate: num(e.taxRate),
      };
    })
    .filter((item) => item.id);

  return {
    client: {
      name: str(client.name, 200),
      email: str(client.email, 200),
      phone: str(client.phone, 50),
      address: str(client.address, 500),
      gstin: str(client.gstin, 15),
    },
    items,
    currency: str(r.currency, 3),
    issueDate: str(r.issueDate, 10),
    dueDate: str(r.dueDate, 10),
    discount: num(r.discount),
    discountType: str(r.discountType, 12),
    shipping: num(r.shipping),
    amountPaid: num(r.amountPaid),
    reference: str(r.reference, 64),
    notes: str(r.notes, 2000),
    terms: str(r.terms, 2000),
  };
}
