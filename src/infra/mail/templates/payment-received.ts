import {
  LINKS,
  actionButton,
  bannerShell,
  greetingLine,
  line,
  rowsPanel,
  signOff,
  small,
  type BannerName,
} from "./shared.js";

const BANNER: BannerName = "payment-received";

export type Invoice = {
  number: string;
  description: string;
  amountLabel: string;
  paymentId: string;
  dateLabel: string;
};

export function paymentReceivedHtml(invoice: Invoice, name?: string): string {
  return bannerShell(
    BANNER,
    `${greetingLine(name)}
     ${line("Your payment went through and your account has already been updated. The receipt is attached to this email as a PDF.")}
     ${rowsPanel(
       `Receipt ${invoice.number}`,
       [
         ["Item", invoice.description],
         ["Date", invoice.dateLabel],
         ["Payment reference", invoice.paymentId || "—"],
         ["Total paid", invoice.amountLabel, true],
       ],
       BANNER,
     )}
     ${actionButton("View billing", `${LINKS.app}/billing`, BANNER)}
     ${small("This is a payment receipt, not a tax invoice — no GST has been charged or collected. Every receipt stays available under Billing in your dashboard.", 18)}
     ${signOff()}`,
  );
}

export function paymentReceivedText(invoice: Invoice, name?: string): string {
  return `Hello${name?.trim() ? ` ${name.trim()}` : ""},

Payment received — thank you.

Receipt ${invoice.number}
${invoice.description}
Amount paid: ${invoice.amountLabel}
Date: ${invoice.dateLabel}
Payment reference: ${invoice.paymentId}

Your receipt is attached as a PDF. You can also download it any time from Billing in your dashboard:
${LINKS.app}/billing

This is a payment receipt, not a tax invoice — no GST has been charged or collected.

The Quantalog Team`;
}
