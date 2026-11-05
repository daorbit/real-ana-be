import { callFormsInternal } from "../../infra/http-client/forms-service.js";

const READ_TIMEOUT_MS = 10_000;
const CONTACTS_TIMEOUT_MS = 25_000;
const BATCH_TIMEOUT_MS = 40_000;
const MAX_CHUNK_CHARS = 1_500_000;

export interface LeadSource {
  id: string;
  title: string;
  responses: number;
}

export interface LeadContact {
  email: string;
  name?: string;
}

export type EmailDelivery =
  | { connected: false }
  | { connected: true; provider: string; providerName: string; fromEmail: string };

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

export interface EmailResult {
  to: string;
  ok: boolean;
  error?: string;
}

export async function leadSources(workspaceId: string): Promise<LeadSource[]> {
  const { forms } = await callFormsInternal<{ forms: LeadSource[] }>("GET", workspaceId, "/leads/sources", READ_TIMEOUT_MS);
  return forms;
}

export async function leadContacts(workspaceId: string, formIds: string[]): Promise<LeadContact[]> {
  if (!formIds.length) return [];
  const { contacts } = await callFormsInternal<{ contacts: LeadContact[] }>(
    "POST",
    workspaceId,
    "/leads/contacts",
    CONTACTS_TIMEOUT_MS,
    { formIds },
  );
  return contacts;
}

export function emailDelivery(workspaceId: string): Promise<EmailDelivery> {
  return callFormsInternal<EmailDelivery>("GET", workspaceId, "/email/status", READ_TIMEOUT_MS);
}

function chunkBySize(messages: OutgoingEmail[]): OutgoingEmail[][] {
  const chunks: OutgoingEmail[][] = [];
  let current: OutgoingEmail[] = [];
  let size = 0;
  for (const message of messages) {
    const bytes = message.html.length + message.text.length;
    if (current.length && size + bytes > MAX_CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(message);
    size += bytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function sendChunk(workspaceId: string, messages: OutgoingEmail[]): Promise<EmailResult[]> {
  try {
    const { results } = await callFormsInternal<{ results: EmailResult[] }>(
      "POST",
      workspaceId,
      "/email/batch",
      BATCH_TIMEOUT_MS,
      { messages },
    );
    return results;
  } catch (e) {
    return messages.map((message) => ({ to: message.to, ok: false, error: (e as Error).message }));
  }
}

export async function sendEmails(workspaceId: string, messages: OutgoingEmail[]): Promise<EmailResult[]> {
  const results: EmailResult[] = [];
  for (const chunk of chunkBySize(messages)) results.push(...(await sendChunk(workspaceId, chunk)));
  return results;
}
