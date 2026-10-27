import axios from "axios";
import { invoiceServiceSecret } from "../../shared/utils/invoice-workspace-token.js";

const PURGE_TIMEOUT_MS = 25_000;

function invoicesBase(): string {
  return (process.env.INVOICES_API_BASE ?? "").replace(/\/$/, "");
}

export async function purgeInvoiceWorkspace(workspaceId: string): Promise<void> {
  const base = invoicesBase();
  const secret = invoiceServiceSecret();
  if (!base || !secret) {
    console.warn("[invoice-service] INVOICES_API_BASE or INVOICE_SERVICE_SECRET is not set, invoice data was not deleted");
    return;
  }

  const { status } = await axios.delete(
    `${base}/api/internal/workspaces/${encodeURIComponent(workspaceId)}`,
    {
      headers: { Authorization: `Bearer ${secret}` },
      timeout: PURGE_TIMEOUT_MS,
      validateStatus: () => true,
    },
  );

  if (status < 200 || status >= 300) {
    throw new Error(`invoice service refused the workspace purge (${status})`);
  }
}
