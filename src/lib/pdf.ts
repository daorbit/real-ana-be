import axios from "axios";

/**
 * HTML to PDF, via an external rendering service.
 *
 * The backend runs on Vercel's serverless runtime, where a bundled Chromium is
 * both too large and too slow to start — so rendering happens somewhere else
 * and comes back as bytes. That makes the choice of service a deployment
 * decision rather than a code one, which is why this module knows about three
 * of them and commits to none.
 *
 * Every provider here takes the same input (a URL or a blob of HTML) and
 * returns the same output (a PDF buffer), so the rest of the codebase asks for
 * `renderPdf` and never learns which one answered.
 *
 * Configured with `PDF_PROVIDER` plus that provider's key. Unconfigured is a
 * supported state: reports fall back to sending a link instead of a file, which
 * is a smaller feature rather than a broken one.
 */

export type PdfProvider = "browserless" | "pdfshift" | "docraptor";

export function pdfConfigured(): boolean {
  return Boolean(process.env.PDF_API_KEY && provider());
}

function provider(): PdfProvider | null {
  const raw = String(process.env.PDF_PROVIDER ?? "").toLowerCase();
  return raw === "browserless" || raw === "pdfshift" || raw === "docraptor" ? raw : null;
}

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfError";
  }
}

/**
 * Render a page to PDF.
 *
 * Takes a URL rather than HTML: the report page is already hosted and public,
 * every provider fetches a URL more reliably than it renders a posted blob, and
 * a URL keeps the request small enough not to matter. The page must be
 * reachable from the public internet — a renderer on someone else's network
 * cannot see `localhost`.
 */
export async function renderPdf(url: string): Promise<Buffer> {
  const which = provider();
  if (!which || !process.env.PDF_API_KEY) {
    throw new PdfError("PDF rendering is not configured");
  }

  try {
    switch (which) {
      case "browserless":
        return await viaBrowserless(url);
      case "pdfshift":
        return await viaPdfShift(url);
      case "docraptor":
        return await viaDocRaptor(url);
    }
  } catch (e) {
    throw new PdfError(describeError(e));
  }
}

/** Browserless: a hosted Chrome, so `printBackground` and margins map straight to Chrome's own options. */
async function viaBrowserless(url: string): Promise<Buffer> {
  const host = process.env.PDF_BASE_URL || "https://production-sfo.browserless.io";
  const { data } = await axios.post(
    `${host}/pdf?token=${encodeURIComponent(process.env.PDF_API_KEY as string)}`,
    {
      url,
      options: {
        format: "A4",
        printBackground: true,
        margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
      },
      // The page is server-rendered HTML with no scripts, so waiting for network
      // idle would only add the timeout to every render.
      gotoOptions: { waitUntil: "domcontentloaded" },
    },
    { responseType: "arraybuffer", timeout: 60_000 }
  );
  return Buffer.from(data);
}

/** PDFShift: HTTP basic auth with the key as the password. */
async function viaPdfShift(url: string): Promise<Buffer> {
  const { data } = await axios.post(
    "https://api.pdfshift.io/v3/convert/pdf",
    { source: url, format: "A4", margin: "16mm", use_print: true },
    {
      responseType: "arraybuffer",
      timeout: 60_000,
      auth: { username: "api", password: process.env.PDF_API_KEY as string },
    }
  );
  return Buffer.from(data);
}

/** DocRaptor: `test: true` watermarks output but doesn't bill, so it follows the env rather than being hardcoded. */
async function viaDocRaptor(url: string): Promise<Buffer> {
  const { data } = await axios.post(
    "https://docraptor.com/docs",
    {
      user_credentials: process.env.PDF_API_KEY,
      doc: {
        document_url: url,
        type: "pdf",
        test: process.env.PDF_TEST_MODE === "true",
        prince_options: { media: "print" },
      },
    },
    { responseType: "arraybuffer", timeout: 60_000 }
  );
  return Buffer.from(data);
}

/**
 * The provider's own error text where there is one.
 *
 * These APIs return their errors as JSON even on a request that asked for
 * binary, so the arraybuffer has to be decoded before it says anything useful —
 * otherwise every failure reads as "Request failed with status code 401".
 */
function describeError(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const body = e.response?.data;
    if (body) {
      try {
        const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
        const parsed = JSON.parse(text) as { message?: string; error?: string; errors?: unknown };
        const message = parsed.message ?? parsed.error ?? (parsed.errors ? JSON.stringify(parsed.errors) : null);
        if (message) return `PDF service: ${message}`;
      } catch {
        // Not JSON — fall through to the status-based message below.
      }
    }
    if (e.code === "ECONNABORTED") return "PDF service timed out";
    return e.response ? `PDF service returned ${e.response.status}` : e.message;
  }
  return (e as Error).message;
}
