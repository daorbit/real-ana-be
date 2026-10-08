import axios from "axios";

const PURGE_TIMEOUT_MS = 25_000;

export async function purgeFormsWorkspace(workspaceId: string): Promise<void> {
  const base = (process.env.FORMS_API_BASE ?? "").replace(/\/$/, "");
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
