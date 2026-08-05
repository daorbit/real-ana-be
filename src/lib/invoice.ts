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
import { PlanPurchase } from "../models/PlanPurchase.js";
import { AddonPurchase } from "../models/AddonPurchase.js";
import { AddonPack } from "../models/AddonPack.js";
import { getResolvedPlan } from "./planPricing.js";
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

export type InvoiceKind = "plan" | "addon";

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

  const [plans, addons] = await Promise.all([
    PlanPurchase.countDocuments(window),
    AddonPurchase.countDocuments(window),
  ]);

  const stamp = `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
  return `QTL-${stamp}-${String(plans + addons + 1).padStart(4, "0")}`;
}

/* ------------------------------- formatting ------------------------------- */

const SYMBOL: Record<string, string> = { INR: "₹", USD: "$" };

/**
 * Smallest unit to a display string.
 *
 * Amounts are stored the way Razorpay takes them — paise and cents — so every
 * display has to divide by 100. Doing it here rather than at each call site is
 * what keeps a receipt from ever quoting a figure a hundred times the charge.
 */
export function formatAmount(amount: number, currency: string): string {
  const value = (amount / 100).toFixed(2);
  return `${SYMBOL[currency] ?? ""}${value}${SYMBOL[currency] ? "" : ` ${currency}`}`;
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
      paymentId: (p.razorpayPaymentId as string) ?? "",
      orderId: p.razorpayOrderId as string,
      description: addons.length ? `${planLine}, plus ${addons.length} add-on pack${addons.length === 1 ? "" : "s"}` : planLine,
      lines,
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
    paymentId: (p.razorpayPaymentId as string) ?? "",
    orderId: p.razorpayOrderId as string,
    description,
    lines: [{ description, amount: p.amount as number }],
    buyer,
  };
}

/* --------------------------------- render --------------------------------- */

const INK = "#111827";
const MUTED = "#6b7280";
const LINE = "#e5e7eb";
const ACCENT = "#047857";

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
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const s = seller();
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // Header: who it's from, and what the document is.
    doc.fillColor(INK).fontSize(20).font("Helvetica-Bold").text(s.name, left, 50);
    if (s.address) {
      doc.fontSize(9).font("Helvetica").fillColor(MUTED)
        .text(s.address, left, doc.y + 4, { width: width * 0.55 });
    }
    if (s.email) doc.fontSize(9).fillColor(MUTED).text(s.email, { width: width * 0.55 });

    doc.fontSize(22).font("Helvetica-Bold").fillColor(ACCENT)
      .text("PAYMENT RECEIPT", left, 52, { width, align: "right" });
    doc.fontSize(10).font("Helvetica").fillColor(MUTED)
      .text(inv.number, left, doc.y + 2, { width, align: "right" })
      .text(formatDate(inv.issuedAt), { width, align: "right" });

    let y = Math.max(doc.y, 140) + 20;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();
    y += 22;

    // Billed-to, and the payment's identifiers beside it. The Razorpay ids are
    // on the document because they are what a support conversation about a
    // disputed charge actually turns on.
    doc.fontSize(8).font("Helvetica-Bold").fillColor(MUTED).text("BILLED TO", left, y);
    doc.fontSize(11).font("Helvetica-Bold").fillColor(INK)
      .text(inv.buyer.name || inv.buyer.email, left, y + 14, { width: width * 0.5 });
    doc.fontSize(9).font("Helvetica").fillColor(MUTED)
      .text(inv.buyer.email, left, doc.y + 2, { width: width * 0.5 });

    const metaX = left + width * 0.55;
    const metaW = width * 0.45;
    doc.fontSize(8).font("Helvetica-Bold").fillColor(MUTED)
      .text("PAYMENT REFERENCE", metaX, y, { width: metaW, align: "right" });
    doc.fontSize(9).font("Helvetica").fillColor(INK)
      .text(inv.paymentId || "—", metaX, y + 14, { width: metaW, align: "right" })
      .fillColor(MUTED).text(inv.orderId, metaX, doc.y + 1, { width: metaW, align: "right" });

    y = doc.y + 34;

    // Line items. A plan bought together with addon packs is several rows on
    // one receipt — one summary line for a payment that covered both would be
    // an incomplete record of where the money went.
    doc.rect(left, y, width, 26).fill("#f3f4f6");
    doc.fillColor(MUTED).fontSize(8).font("Helvetica-Bold")
      .text("DESCRIPTION", left + 12, y + 9)
      .text("AMOUNT", left, y + 9, { width: width - 12, align: "right" });

    y += 26;

    for (const line of inv.lines) {
      doc.fillColor(INK).fontSize(10).font("Helvetica")
        .text(line.description, left + 12, y + 12, { width: width * 0.62 });
      // The amount is drawn at the row's own top rather than after the
      // description, so a description that wraps to two lines doesn't push its
      // price out of alignment with the row it belongs to.
      doc.font("Helvetica-Bold")
        .text(formatAmount(line.amount, inv.currency), left, y + 12, {
          width: width - 12,
          align: "right",
        });
      y = doc.y + 6;
    }

    y += 8;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 14;

    // The subtotal and discount only appear when a coupon actually moved the
    // figure. On a receipt with no coupon they would be two rows of noise
    // restating the total.
    const subtotal = inv.lines.reduce((sum, line) => sum + line.amount, 0);
    const discount = subtotal - inv.amount;

    if (inv.couponCode && discount > 0) {
      doc.fontSize(9).font("Helvetica").fillColor(MUTED)
        .text("Subtotal", left + width * 0.5, y, { width: width * 0.5 - 90, align: "right" })
        .text(formatAmount(subtotal, inv.currency), left, y, { width: width - 12, align: "right" });
      y += 16;

      doc.fillColor(MUTED)
        .text(`Coupon ${inv.couponCode}`, left + width * 0.5, y, { width: width * 0.5 - 90, align: "right" })
        .fillColor(ACCENT)
        .text(`− ${formatAmount(discount, inv.currency)}`, left, y, { width: width - 12, align: "right" });
      y += 20;
    }

    doc.fontSize(9).font("Helvetica-Bold").fillColor(MUTED)
      .text("TOTAL PAID", left + width * 0.5, y, { width: width * 0.5 - 90, align: "right" });
    doc.fontSize(15).font("Helvetica-Bold").fillColor(ACCENT)
      .text(formatAmount(inv.amount, inv.currency), left, y - 4, { width, align: "right" });

    // The footer is where the no-GST position is stated outright. Silence would
    // read as an omission; saying it plainly is what makes the document
    // complete for its own kind.
    const footY = doc.page.height - doc.page.margins.bottom - 54;
    doc.moveTo(left, footY).lineTo(right, footY).strokeColor(LINE).stroke();
    doc.fontSize(8).font("Helvetica").fillColor(MUTED).text(
      "This is a payment receipt, not a tax invoice. No GST has been charged or collected — " +
        `${s.name} is not registered for GST. Paid online via Razorpay; no signature is required.`,
      left,
      footY + 12,
      { width, align: "left" },
    );

    doc.end();
  });
}
