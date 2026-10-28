import type { Request, Response } from "express";
import { invoiceServiceSecret } from "../../shared/utils/invoice-workspace-token.js";

export function authorizeInvoiceService(req: Request, res: Response): boolean {
  const secret = invoiceServiceSecret();
  if (!secret) {
    console.error("[invoices-internal] INVOICE_SERVICE_SECRET is not set, refusing");
    res.status(503).json({ error: "invoices integration is not configured" });
    return false;
  }
  if (req.get("authorization") !== `Bearer ${secret}`) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}
