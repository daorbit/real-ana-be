import {
  designHasContent,
  designProblem,
  parseEmailDesign,
  sanitizeCustomHtml,
  type EmailDesign,
} from "./campaign-design.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_IMPORTED = 5_000;
const MAX_FORMS = 50;

export type CampaignMode = "design" | "html";

export interface CampaignContact {
  email: string;
  name: string;
}

export interface CampaignDraft {
  name: string;
  subject: string;
  preheader: string;
  mode: CampaignMode;
  design: EmailDesign;
  html: string;
  senderAddress: string;
  formIds: string[];
  imported: CampaignContact[];
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function contacts(value: unknown): CampaignContact[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, CampaignContact>();
  for (const entry of value.slice(0, MAX_IMPORTED)) {
    const raw = (entry ?? {}) as Record<string, unknown>;
    const email = text(raw.email, 200).toLowerCase();
    if (EMAIL.test(email)) unique.set(email, { email, name: text(raw.name, 120) });
  }
  return [...unique.values()];
}

export function parseCampaignDraft(body: unknown): CampaignDraft | string {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const name = text(raw.name, 120);
  if (!name) return "Give the campaign a name.";

  return {
    name,
    subject: text(raw.subject, 200),
    preheader: text(raw.preheader, 200),
    mode: raw.mode === "html" ? "html" : "design",
    design: parseEmailDesign(raw.design),
    html: sanitizeCustomHtml(raw.html),
    senderAddress: text(raw.senderAddress, 300),
    formIds: Array.isArray(raw.formIds) ? raw.formIds.map(String).slice(0, MAX_FORMS) : [],
    imported: contacts(raw.imported),
  };
}

export function sendProblem(
  draft: Pick<CampaignDraft, "subject" | "mode" | "design" | "html" | "senderAddress">,
): string | null {
  if (!draft.subject) return "Add a subject line before sending.";
  const hasContent = draft.mode === "html" ? Boolean(draft.html.trim()) : designHasContent(draft.design);
  if (!hasContent) return "Add some content to the email before sending.";
  const problem = draft.mode === "design" ? designProblem(draft.design, draft.subject) : null;
  if (problem) return problem;
  if (!draft.senderAddress) return "Add your business postal address. It appears in the email footer.";
  return null;
}

export function isEmailAddress(value: unknown): value is string {
  return typeof value === "string" && EMAIL.test(value.trim());
}
