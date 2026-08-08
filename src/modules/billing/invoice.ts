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
/** The tint behind the header band and the totals block. */
const WASH = "#f8fafc";

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

    // A tinted band behind the header, bled to the page edges. Gives the
    // document a masthead rather than starting cold on white, which is most of
    // what separates a receipt that looks issued from one that looks printed.
    const bandHeight = 118;
    doc.rect(0, 0, doc.page.width, bandHeight).fill(WASH);
    doc.moveTo(0, bandHeight).lineTo(doc.page.width, bandHeight)
      .strokeColor(LINE).lineWidth(1).stroke();

    // Header left: the mark, then the seller's details beneath it.
    const logoSize = 30;
    let nameX = left;

    if (LOGO) {
      doc.image(LOGO, left, 38, { width: logoSize, height: logoSize });
      nameX = left + logoSize + 10;
    }

    doc.fillColor(INK).fontSize(17).font("Helvetica-Bold")
      .text(pdfSafe(s.name), nameX, 45, { width: width * 0.55, lineBreak: false });

    let sellerY = 38 + logoSize + 8;
    if (s.address) {
      doc.fontSize(8.5).font("Helvetica").fillColor(MUTED)
        .text(pdfSafe(s.address), left, sellerY, { width: width * 0.5 });
      sellerY = doc.y;
    }
    if (s.email) {
      doc.fontSize(8.5).font("Helvetica").fillColor(MUTED)
        .text(pdfSafe(s.email), left, sellerY + 1, { width: width * 0.5 });
    }

    // Header right: what this document is, then its identifiers as a small
    // label/value pair — the number is what someone quotes over support, so it
    // gets a label rather than sitting as a bare string.
    doc.fontSize(19).font("Helvetica-Bold").fillColor(ACCENT)
      .text("PAYMENT RECEIPT", left, 42, { width, align: "right" });

    const metaLabel = (label: string, value: string, atY: number) => {
      doc.fontSize(7.5).font("Helvetica-Bold").fillColor(MUTED)
        .text(label.toUpperCase(), left, atY, { width, align: "right", characterSpacing: 0.5 });
      doc.fontSize(10).font("Helvetica-Bold").fillColor(INK)
        .text(value, left, atY + 10, { width, align: "right" });
    };

    metaLabel("Receipt no.", inv.number, 70);
    metaLabel("Date", formatDate(inv.issuedAt), 94);

    let y = bandHeight + 28;

    // Billed-to, and the payment's identifiers beside it. The Razorpay ids are
    // on the document because they are what a support conversation about a
    // disputed charge actually turns on.
    doc.fontSize(7.5).font("Helvetica-Bold").fillColor(MUTED)
      .text("BILLED TO", left, y, { characterSpacing: 0.5 });
    doc.fontSize(11.5).font("Helvetica-Bold").fillColor(INK)
      .text(pdfSafe(inv.buyer.name || inv.buyer.email), left, y + 13, { width: width * 0.5 });
    doc.fontSize(9).font("Helvetica").fillColor(MUTED)
      .text(pdfSafe(inv.buyer.email), left, doc.y + 2, { width: width * 0.5 });

    const buyerBottom = doc.y;

    // The Razorpay identifiers. On the document because they are what a
    // support conversation about a disputed charge actually turns on — set in
    // a monospaced face so a long id can be read back character by character.
    const metaX = left + width * 0.55;
    const metaW = width * 0.45;
    doc.fontSize(7.5).font("Helvetica-Bold").fillColor(MUTED)
      .text("PAYMENT REFERENCE", metaX, y, { width: metaW, align: "right", characterSpacing: 0.5 });
    doc.fontSize(9).font("Courier-Bold").fillColor(INK)
      .text(inv.paymentId || "—", metaX, y + 13, { width: metaW, align: "right" });
    doc.fontSize(8).font("Courier").fillColor(MUTED)
      .text(inv.orderId, metaX, doc.y + 2, { width: metaW, align: "right" });

    y = Math.max(buyerBottom, doc.y) + 30;

    // Line items. A plan bought together with addon packs is several rows on
    // one receipt — one summary line for a payment that covered both would be
    // an incomplete record of where the money went.
    const AMOUNT_COL = 140;
    const descWidth = width - AMOUNT_COL - 24;

    doc.rect(left, y, width, 24).fill(INK);
    doc.fillColor("#ffffff").fontSize(7.5).font("Helvetica-Bold")
      .text("DESCRIPTION", left + 12, y + 8.5, { characterSpacing: 0.5 })
      .text("AMOUNT", left, y + 8.5, { width: width - 12, align: "right", characterSpacing: 0.5 });

    y += 24;

    inv.lines.forEach((line, i) => {
      const rowTop = y;

      doc.fillColor(INK).fontSize(10).font("Helvetica")
        .text(pdfSafe(line.description), left + 12, rowTop + 11, { width: descWidth });

      // Drawn from the row's own top rather than after the description, so a
      // description that wraps to two lines keeps its price on the first.
      doc.font("Helvetica-Bold")
        .text(formatAmount(line.amount, inv.currency), left, rowTop + 11, {
          width: width - 12,
          align: "right",
        });

      y = Math.max(doc.y, rowTop + 26) + 6;

      // Hairline between rows, but not after the last — that edge is the
      // table's own boundary and gets a heavier rule below.
      if (i < inv.lines.length - 1) {
        doc.moveTo(left + 12, y).lineTo(right - 12, y).strokeColor(LINE).lineWidth(0.5).stroke();
        y += 6;
      }
    });

    y += 4;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();
    y += 16;

    // Totals, right-aligned in their own column so the figures line up under
    // the amounts above rather than floating in the middle of the page.
    const totalsX = right - 240;
    const labelW = 130;
    const valueW = 110;

    const totalRow = (label: string, value: string, opts: { bold?: boolean; color?: string } = {}) => {
      doc.fontSize(9.5).font(opts.bold ? "Helvetica-Bold" : "Helvetica").fillColor(MUTED)
        .text(pdfSafe(label), totalsX, y, { width: labelW, align: "right" });
      doc.font("Helvetica-Bold").fillColor(opts.color ?? INK)
        .text(pdfSafe(value), totalsX + labelW + 10, y, { width: valueW, align: "right" });
      y += 17;
    };

    // Subtotal and discount only appear when a coupon actually moved the
    // figure. On a receipt with no coupon they would be two rows of noise
    // restating the total.
    const subtotal = inv.lines.reduce((sum, line) => sum + line.amount, 0);
    const discount = subtotal - inv.amount;

    if (inv.couponCode && discount > 0) {
      totalRow("Subtotal", formatAmount(subtotal, inv.currency));
      // A hyphen, not a minus sign (U+2212): the built-in PDF fonts have no
      // glyph for the latter and substitute a quote mark, which on a discount
      // line reads as nonsense.
      totalRow(`Coupon ${inv.couponCode}`, `- ${formatAmount(discount, inv.currency)}`, {
        color: ACCENT,
      });
      y += 2;
    }

    // The total sits in a filled panel — on a page of plain rows it is the one
    // figure anyone scans for, and it should be findable without reading.
    const panelH = 38;
    doc.rect(totalsX, y - 4, 240, panelH).fill(WASH);
    doc.rect(totalsX, y - 4, 3, panelH).fill(ACCENT);

    doc.fontSize(9).font("Helvetica-Bold").fillColor(MUTED)
      .text("TOTAL PAID", totalsX + 14, y + 8, { width: labelW - 14, align: "left", characterSpacing: 0.3 });
    doc.fontSize(16).font("Helvetica-Bold").fillColor(ACCENT)
      .text(formatAmount(inv.amount, inv.currency), totalsX + labelW, y + 4, {
        width: valueW + 10,
        align: "right",
      });

    y += panelH + 10;

    // A plain-language settlement line. The status is the reason the document
    // exists — "paid" said once, in words, beats leaving the reader to infer it
    // from the heading.
    doc.fontSize(9).font("Helvetica").fillColor(MUTED)
      .text(
        `Paid in full on ${formatDate(inv.issuedAt)} via Razorpay. No amount is outstanding.`,
        left,
        y,
        { width },
      );

    // The footer is where the no-GST position is stated outright. Silence would
    // read as an omission; saying it plainly is what makes the document
    // complete for its own kind.
    const footY = doc.page.height - doc.page.margins.bottom - 58;
    doc.moveTo(left, footY).lineTo(right, footY).strokeColor(LINE).lineWidth(1).stroke();

    doc.fontSize(7.5).font("Helvetica").fillColor(MUTED).text(
      "This is a payment receipt, not a tax invoice. No GST has been charged or collected — " +
        `${s.name} is not registered for GST. Paid online via Razorpay; no signature is required.`,
      left,
      footY + 12,
      { width: width * 0.68, align: "left", lineGap: 1.5 },
    );

    // The receipt number repeated at the foot, so a page separated from its
    // email is still identifiable on its own.
    doc.fontSize(7.5).font("Helvetica-Bold").fillColor(MUTED)
      .text(inv.number, left + width * 0.7, footY + 12, { width: width * 0.3, align: "right" });

    doc.end();
  });
}
