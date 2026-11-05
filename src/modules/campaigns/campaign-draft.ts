const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINK = /^https?:\/\/[^\s"'<>]+$/i;
const MAX_IMPORTED = 5_000;
const MAX_FORMS = 50;

export interface CampaignContact {
  email: string;
  name: string;
}

export interface CampaignDraft {
  name: string;
  subject: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
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

  const ctaUrl = text(raw.ctaUrl, 500);
  if (ctaUrl && !LINK.test(ctaUrl)) return "The button link must start with http:// or https://.";

  return {
    name,
    subject: text(raw.subject, 200),
    body: text(raw.body, 20_000),
    ctaLabel: text(raw.ctaLabel, 40),
    ctaUrl,
    senderAddress: text(raw.senderAddress, 300),
    formIds: Array.isArray(raw.formIds) ? raw.formIds.map(String).slice(0, MAX_FORMS) : [],
    imported: contacts(raw.imported),
  };
}

export function sendProblem(draft: Pick<CampaignDraft, "subject" | "body" | "senderAddress">): string | null {
  if (!draft.subject) return "Add a subject line before sending.";
  if (!draft.body) return "Write the email before sending.";
  if (!draft.senderAddress) return "Add your business postal address. It appears in the email footer.";
  return null;
}

export function isEmailAddress(value: unknown): value is string {
  return typeof value === "string" && EMAIL.test(value.trim());
}
