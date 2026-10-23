/**
 * Payment receipts for plan periods and addon packs.
 *
 * Deliberately a *receipt*, not a tax invoice: the business is not GST
 * registered, so there is no GSTIN to print and no tax line to break out.
 * Printing either would be a false statement on a financial document, and the
 * absence of a tax breakdown is what makes this document honest rather than
 * incomplete.
 *
 * A receipt is issued only for money that actually arrived — the number is
 * assigned at credit time, not when the Razorpay order is created, so abandoned
 * checkouts don't burn numbers and leave gaps in the sequence.
 */

import PDFDocument from "pdfkit";
import { Types } from "mongoose";
import { LOGO_DATA_URI } from "../seo/logo.js";
import { PlanPurchase } from "./models/PlanPurchase.js";
import { AddonPurchase } from "./models/AddonPurchase.js";
import { AppPurchase } from "./models/AppPurchase.js";
import { PAID_APP_NAMES, isPaidApp } from "./paid-apps.catalog.js";
import { AddonPack } from "./models/AddonPack.js";
import { getResolvedPlan } from "./plan-pricing.js";
import type { Currency } from "./currency.js";

/**
 * Who the receipt is from.
 *
 * Environment rather than the database: the legal name and address of the
 * business change roughly never, and a value that is wrong on a document
 * already emailed cannot be corrected after the fact — an env var that fails
 * loudly on a fresh deploy is safer than a settings row someone can blank.
 */
export function seller() {
  return {
    name: process.env.INVOICE_SELLER_NAME || "Quantalog",
    address: process.env.INVOICE_SELLER_ADDRESS || "",
    email: process.env.INVOICE_SELLER_EMAIL || process.env.SMTP_FROM || "",
  };
}

export type InvoiceKind = "plan" | "addon" | "app";

export function appPurchaseDescription(appId: string): string {
  const name = isPaidApp(appId) ? PAID_APP_NAMES[appId] : appId;
  return `${name} — one-time unlock`;
}

/** Everything a rendered receipt needs, resolved from a paid purchase row. */
export type InvoiceData = {
  id: string;
  kind: InvoiceKind;
  number: string;
  issuedAt: Date;
  /** Smallest currency unit, as charged — paise for INR, cents for USD. */
  amount: number;
  currency: Currency;
  couponCode: string;
  gateway: string;
  paymentId: string;
  orderId: string;
  /** One line summarising the purchase, for lists and the email subject. */
  description: string;
  /**
   * The itemised breakdown.
   *
   * A plan bought with addon packs in one checkout is several lines on one
   * receipt — a single "Pro plan" line for a payment that also bought 200
   * credits would be an incomplete record of what the money went on.
   */
  lines: { description: string; amount: number }[];
  buyer: { name: string; email: string };
};

/* ------------------------------- numbering -------------------------------- */

/**
 * `QTL-YYYYMM-NNNN`, where the counter restarts each month.
 *
 * Scoped per month rather than globally so the sequence stays short and
 * human-quotable over support, and derived by counting the receipts already
 * issued in the month rather than from a separate counter document — one less
 * thing that can drift out of step with the rows it is meant to describe.
 *
 * A race here (two purchases credited in the same millisecond) can in principle
 * mint the same number twice. That is accepted: the unique key on a receipt is
 * the purchase row, the number is a label, and a collision costs a duplicated
 * label rather than a lost or double-credited payment.
 */
export async function nextInvoiceNumber(at: Date = new Date()): Promise<string> {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  const window = { invoiceNumber: { $ne: "" }, invoicedAt: { $gte: start, $lt: end } };

  const [plans, addons, apps] = await Promise.all([
    PlanPurchase.countDocuments(window),
    AddonPurchase.countDocuments(window),
    AppPurchase.countDocuments(window),
  ]);

  const stamp = `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
  return `QTL-${stamp}-${String(plans + addons + apps + 1).padStart(4, "0")}`;
}

/* ------------------------------- formatting ------------------------------- */

/**
 * Currency symbols for the PDF.
 *
 * INR is written "Rs." rather than "₹" on purpose. The built-in PDF fonts use
 * WinAnsi encoding, which has no rupee glyph — pdfkit emits an apostrophe in
 * its place, so "₹999.00" reaches the customer as "'999.00" on a document
 * about money. Embedding a Unicode font would fix the glyph at the cost of
 * bundling a font file into a serverless deploy; "Rs." is unambiguous, needs
 * nothing, and cannot render as the wrong character.
 *
 * The HTML email and the dashboard both use real symbols — this constraint is
 * the PDF's alone.
 */
const SYMBOL: Record<string, string> = { INR: "Rs. ", USD: "$" };

/**
 * Smallest unit to a display string.
 *
 * Amounts are stored the way Razorpay takes them — paise and cents — so every
 * display has to divide by 100. Doing it here rather than at each call site is
 * what keeps a receipt from ever quoting a figure a hundred times the charge.
 *
 * Thousands separators because these are read by people checking a charge
 * against a bank statement, and "119600.00" is meaningfully harder to verify
 * at a glance than "1,196.00".
 */
export function formatAmount(amount: number, currency: string): string {
  // Grouped in the convention of the currency being charged: INR groups as
  // 1,19,600 and USD as 119,600. A receipt in rupees that groups the American
  // way looks foreign to the person reconciling it.
  const value = (amount / 100).toLocaleString(currency === "INR" ? "en-IN" : "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const symbol = SYMBOL[currency];
  return symbol ? `${symbol}${value}` : `${value} ${currency}`;
}

/**
 * Replace characters the built-in PDF fonts cannot draw.
 *
 * WinAnsi covers most of what a receipt needs — em dashes, `×`, curly quotes
 * all render — but a handful of characters have no glyph and come out as an
 * unrelated symbol rather than as nothing, which is how "₹999" became "'999".
 * Applied to every string that reaches the page, so a description typed into
 * the admin panel can't reintroduce the problem.
 *
 * Verified by width: pdfkit reports zero for a character the font cannot
 * represent.
 */
const GLYPH_FALLBACKS: [RegExp, string][] = [
  [/−/g, "-"],      // minus sign
  [/₹/g, "Rs. "],   // rupee
  [/[  ]/g, " "], // narrow / non-breaking space
];

function pdfSafe(text: string): string {
  return GLYPH_FALLBACKS.reduce((s, [pattern, replacement]) => s.replace(pattern, replacement), String(text));
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/* ------------------------------- resolution ------------------------------- */

/**
 * Build the receipt for one paid purchase.
 *
 * Returns `null` for a purchase that isn't paid or has no number yet — the
 * routes lean on this rather than checking status themselves, so an unpaid
 * order can't be turned into a document that says money changed hands.
 */
export async function buildInvoice(
  kind: InvoiceKind,
  purchaseId: string,
  userId: string,
  buyer: { name: string; email: string },
): Promise<InvoiceData | null> {
  if (!Types.ObjectId.isValid(purchaseId)) return null;

  if (kind === "plan") {
    const p = await PlanPurchase.findOne({ _id: purchaseId, userId, status: "paid" });
    if (!p || !p.invoiceNumber) return null;

    // Fall back to the stored slug if the plan has since been renamed or
    // retired — a receipt describes what was sold at the time, and a blank
    // line item would be worse than an unpolished one.
    const plan = await getResolvedPlan(p.planSlug as string);
    const name = plan?.name ?? (p.planSlug as string);
    const planLine = `${name} plan — ${p.cycle === "yearly" ? "12 months" : "1 month"}`;

    const addons = (p.addons ?? []) as unknown as {
      name: string;
      quantity: number;
      packs: number;
      unitAmount: number;
      type: string;
    }[];

    // The plan's own price is recorded separately from the order total, so a
    // receipt can show what each part cost. Rows written before combined
    // checkout have no `planAmount` and no addons — for those the plan line is
    // the whole charge.
    const planAmount = (p.planAmount as number) || (addons.length ? 0 : (p.amount as number));

    const lines = [
      { description: planLine, amount: planAmount },
      ...addons.map((a) => ({
        description:
          `${a.name} × ${a.packs} — ${a.quantity * a.packs} ${a.type === "audit" ? "audit" : "crawl"} credits`,
        amount: a.unitAmount * a.packs,
      })),
    ];

    return {
      id: p.id,
      kind,
      number: p.invoiceNumber as string,
      issuedAt: (p.invoicedAt as Date) ?? p.get("createdAt"),
      amount: p.amount as number,
      currency: p.currency as Currency,
      couponCode: (p.couponCode as string) ?? "",
      gateway: (p.gateway as string) ?? "razorpay",
      paymentId: (p.razorpayPaymentId as string) ?? "",
      orderId: (p.razorpayOrderId as string) || (p.cashfreeOrderId as string) || "",
      description: addons.length ? `${planLine}, plus ${addons.length} add-on pack${addons.length === 1 ? "" : "s"}` : planLine,
      lines,
      buyer,
    };
  }

  if (kind === "app") {
    const a = await AppPurchase.findOne({ _id: purchaseId, userId, status: "paid" });
    if (!a || !a.invoiceNumber) return null;
    const description = appPurchaseDescription(a.appId as string);
    return {
      id: a.id,
      kind,
      number: a.invoiceNumber as string,
      issuedAt: (a.invoicedAt as Date) ?? a.get("createdAt"),
      amount: a.amount as number,
      currency: a.currency as Currency,
      couponCode: (a.couponCode as string) ?? "",
      gateway: (a.gateway as string) ?? "razorpay",
      paymentId: (a.razorpayPaymentId as string) ?? "",
      orderId: (a.razorpayOrderId as string) || (a.cashfreeOrderId as string) || "",
      description,
      lines: [{ description, amount: a.amount as number }],
      buyer,
    };
  }

  const p = await AddonPurchase.findOne({ _id: purchaseId, userId, status: "paid" });
  if (!p || !p.invoiceNumber) return null;

  const pack = await AddonPack.findById(p.addonPackId);
  const packs = (p.packs as number) ?? 1;
  const description = pack
    ? `${pack.name}${packs > 1 ? ` × ${packs}` : ""} — ${(pack.quantity as number) * packs} ${pack.type === "audit" ? "audit" : "crawl"} credits`
    : "Add-on credit pack";

  return {
    id: p.id,
    kind,
    number: p.invoiceNumber as string,
    issuedAt: (p.invoicedAt as Date) ?? p.get("createdAt"),
    amount: p.amount as number,
    currency: p.currency as Currency,
    couponCode: (p.couponCode as string) ?? "",
    gateway: (p.get("gateway") as string) ?? "razorpay",
    paymentId: (p.razorpayPaymentId as string) ?? "",
    orderId: (p.razorpayOrderId as string) || (p.get("cashfreeOrderId") as string) || "",
    description,
    lines: [{ description, amount: p.amount as number }],
    buyer,
  };
}

/* --------------------------------- render --------------------------------- */

const INK = "#111114";
const MUTED = "#6e6e73";
const FAINT = "#8e8e93";
const LINE = "#e5e5ea";
const RULE = "#d1d1d6";
const PAID = "#1f7a3d";
const PAID_WASH = "#e8f5ec";

/**
 * The mark, decoded once at module load.
 *
 * pdfkit takes image bytes directly, so the data URI's base64 payload is
 * unwrapped here rather than on every render — the same buffer is embedded into
 * each document. A failure to decode leaves this null and the header falls back
 * to the wordmark alone: a receipt without a logo is worth sending, a receipt
 * that throws is not.
 */
const LOGO: Buffer | null = (() => {
  try {
    const payload = LOGO_DATA_URI.split(",")[1];
    return payload ? Buffer.from(payload, "base64") : null;
  } catch {
    return null;
  }
})();

function gatewayLabel(gateway: string): string {
  if (gateway === "coupon") return "Coupon";
  if (gateway === "cashfree") return "Cashfree";
  return "Razorpay";
}

/**
 * The receipt as a PDF, buffered rather than streamed.
 *
 * Buffered because both callers need the whole thing before they can act:
 * nodemailer wants a `Buffer` for the attachment, and the download route has to
 * know the length. A one-page document is small enough that holding it in
 * memory costs nothing.
 *
 * Drawn with pdfkit's primitives instead of rendering HTML through a headless
 * browser: this runs on a serverless host where a bundled Chromium is both a
 * cold-start cost and a deployment size problem, for a document that is a
 * header, a table with one row, and a total.
 */
export function renderInvoicePdf(inv: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const s = seller();
    const doc = new PDFDocument({
      size: "A4",
      margin: 56,
      info: { Title: `Receipt ${inv.number}`, Author: s.name },
    });
    const chunks: Buffer[] = [];

    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    const hairline = (atY: number, from = left, to = right, color = LINE) => {
      doc.moveTo(from, atY).lineTo(to, atY).strokeColor(color).lineWidth(0.75).stroke();
    };

    let y = doc.page.margins.top;

    const logoSize = 26;
    let nameX = left;
    if (LOGO) {
      doc.image(LOGO, left, y, { width: logoSize, height: logoSize });
      nameX = left + logoSize + 10;
    }
    doc.font("Helvetica-Bold").fontSize(13).fillColor(INK)
      .text(pdfSafe(s.name), nameX, y + 7, { width: width * 0.6, lineBreak: false });

    const pillText = "PAID";
    doc.font("Helvetica-Bold").fontSize(7.5);
    const pillW = doc.widthOfString(pillText, { characterSpacing: 1 }) + 22;
    doc.roundedRect(right - pillW, y + 3, pillW, 20, 10).fill(PAID_WASH);
    doc.fillColor(PAID)
      .text(pillText, right - pillW, y + 9.5, { width: pillW, align: "center", characterSpacing: 1 });

    y += 70;

    doc.font("Helvetica").fontSize(11).fillColor(MUTED).text("Receipt", left, y);
    y += 18;
    doc.font("Helvetica-Bold").fontSize(32).fillColor(INK)
      .text(pdfSafe(formatAmount(inv.amount, inv.currency)), left, y);
    y = doc.y + 2;
    doc.font("Helvetica").fontSize(11).fillColor(MUTED)
      .text(`Paid on ${formatDate(inv.issuedAt)}`, left, y);
    y = doc.y + 30;

    const meta: [string, string][] = [
      ["Receipt number", inv.number],
      ["Date paid", formatDate(inv.issuedAt)],
      ["Payment method", gatewayLabel(inv.gateway)],
    ];
    const metaW = width / meta.length;
    meta.forEach(([label, value], i) => {
      const x = left + metaW * i;
      doc.font("Helvetica").fontSize(8.5).fillColor(FAINT).text(label, x, y, { width: metaW - 12 });
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(pdfSafe(value), x, y + 14, { width: metaW - 12 });
    });
    y += 46;

    hairline(y);
    y += 24;

    const half = width / 2;
    const party = (label: string, title: string, rows: string[], x: number) => {
      doc.font("Helvetica").fontSize(8.5).fillColor(FAINT).text(label, x, y, { width: half - 16 });
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK)
        .text(pdfSafe(title), x, y + 14, { width: half - 16 });
      rows.filter(Boolean).forEach((row) => {
        doc.font("Helvetica").fontSize(9.5).fillColor(MUTED)
          .text(pdfSafe(row), x, doc.y + 2, { width: half - 16, lineGap: 1 });
      });
      return doc.y;
    };

    const fromBottom = party("From", s.name, [s.address, s.email], left);
    const toBottom = party("Billed to", inv.buyer.name || inv.buyer.email, inv.buyer.name ? [inv.buyer.email] : [], left + half);
    y = Math.max(fromBottom, toBottom) + 34;

    doc.font("Helvetica").fontSize(8.5).fillColor(FAINT)
      .text("Description", left, y)
      .text("Amount", left, y, { width, align: "right" });
    y += 16;
    hairline(y, left, right, RULE);

    const amountW = 130;
    inv.lines.forEach((line) => {
      const rowTop = y + 13;
      doc.font("Helvetica").fontSize(10.5).fillColor(INK)
        .text(pdfSafe(line.description), left, rowTop, { width: width - amountW - 16 });
      const descBottom = doc.y;
      doc.font("Helvetica").fontSize(10.5).fillColor(INK)
        .text(pdfSafe(formatAmount(line.amount, inv.currency)), right - amountW, rowTop, { width: amountW, align: "right" });
      y = Math.max(descBottom, doc.y) + 13;
      hairline(y);
    });

    y += 16;

    const totalsX = left + width * 0.5;
    const totalsW = width * 0.5;
    const totalRow = (label: string, value: string, strong = false) => {
      const size = strong ? 11.5 : 10;
      doc.font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(strong ? INK : MUTED)
        .text(pdfSafe(label), totalsX, y, { width: totalsW * 0.6 });
      doc.font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(INK)
        .text(pdfSafe(value), totalsX, y, { width: totalsW, align: "right" });
      y += strong ? 22 : 19;
    };

    const subtotal = inv.lines.reduce((sum, line) => sum + line.amount, 0);
    const discount = subtotal - inv.amount;

    totalRow("Subtotal", formatAmount(subtotal, inv.currency));
    if (inv.couponCode && discount > 0) {
      totalRow(`Discount (${inv.couponCode})`, `- ${formatAmount(discount, inv.currency)}`);
    }
    totalRow("Total", formatAmount(inv.amount, inv.currency));

    y += 2;
    hairline(y, totalsX, right, RULE);
    y += 12;
    totalRow("Amount paid", formatAmount(inv.amount, inv.currency), true);

    y += 22;

    doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(
      inv.gateway === "coupon"
        ? `Covered in full by coupon ${inv.couponCode} on ${formatDate(inv.issuedAt)}. Nothing was charged and nothing is outstanding.`
        : `Paid in full on ${formatDate(inv.issuedAt)} via ${gatewayLabel(inv.gateway)}. Nothing is outstanding.`,
      left,
      y,
      { width },
    );
    y = doc.y + 18;

    const references: [string, string][] = [
      ["Payment ID", inv.paymentId],
      ["Order ID", inv.orderId],
    ].filter(([, value]) => Boolean(value)) as [string, string][];

    references.forEach(([label, value]) => {
      doc.font("Helvetica").fontSize(8.5).fillColor(FAINT).text(label, left, y, { width: 80 });
      doc.font("Courier").fontSize(8.5).fillColor(MUTED).text(value, left + 80, y, { width: width - 80 });
      y = doc.y + 4;
    });

    const footY = doc.page.height - doc.page.margins.bottom - 40;
    hairline(footY);

    doc.font("Helvetica").fontSize(8).fillColor(FAINT).text(
      `This is a payment receipt, not a tax invoice. No GST has been charged or collected; ${pdfSafe(s.name)} is not registered for GST.`,
      left,
      footY + 12,
      { width: width * 0.68, lineGap: 1.5 },
    );
    doc.font("Helvetica").fontSize(8).fillColor(FAINT)
      .text(`${inv.number}  ·  Page 1 of 1`, left + width * 0.7, footY + 12, { width: width * 0.3, align: "right" });

    doc.end();
  });
}
