export function invoiceServiceSecret(): string | null {
  return process.env.INVOICE_SERVICE_SECRET || null;
}
