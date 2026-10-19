import axios from "axios";
import { formsServiceSecret, signFormsWorkspaceToken } from "../../shared/utils/forms-workspace-token.js";

const PURGE_TIMEOUT_MS = 25_000;
const READ_TIMEOUT_MS = 8_000;
const READ_TOKEN_TTL_SECONDS = 60;
const MAX_READ_BYTES = 2 * 1024 * 1024;

function formsBase(): string {
  return (process.env.FORMS_API_BASE ?? "").replace(/\/$/, "");
}

export class FormsServiceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "FormsServiceError";
  }
}

export async function purgeFormsWorkspace(workspaceId: string): Promise<void> {
  const base = formsBase();
  const secret = process.env.FORMS_SERVICE_SECRET;
  if (!base || !secret) {
    console.error("[forms-service] FORMS_API_BASE or FORMS_SERVICE_SECRET is not set — forms data was not deleted");
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
    throw new Error(`forms service refused the workspace purge (${status})`);
  }
}

export async function readFormsWorkspace<T>(
  workspaceId: string,
  actorId: string,
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const base = formsBase();
  const secret = formsServiceSecret();
  if (!base || !secret) throw new FormsServiceError(503, "forms integration is not configured");

  const { token } = signFormsWorkspaceToken(secret, workspaceId, actorId, READ_TOKEN_TTL_SECONDS);
  const { status, data } = await axios.get(
    `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/forms${path}`,
    {
      params,
      headers: { Authorization: `Bearer ${token}` },
      timeout: READ_TIMEOUT_MS,
      maxContentLength: MAX_READ_BYTES,
      validateStatus: () => true,
    },
  ).catch((e: unknown) => {
    throw new FormsServiceError(502, e instanceof Error ? e.message : "forms service unreachable");
  });

  if (status === 404) throw new FormsServiceError(404, "not found");
  if (status < 200 || status >= 300) throw new FormsServiceError(status >= 500 ? 502 : status, `forms service answered ${status}`);
  return data as T;
}
