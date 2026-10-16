import type { AuthedRequest } from "../middleware/auth.js";
import type { WorkspaceRole } from "../../modules/workspace/models/Membership.js";
import { APP_DISABLED_MESSAGE, appEnabled } from "../../modules/workspace/apps.service.js";
import { resolveSite, siteRefused, type SiteResult } from "./resolve-site.js";

export async function resolveCompareSite(req: AuthedRequest, minimum: WorkspaceRole = "viewer"): Promise<SiteResult> {
  const found = await resolveSite(req, minimum);
  if (siteRefused(found)) return found;
  if (!appEnabled(found.ws, "compare")) return { error: APP_DISABLED_MESSAGE.compare, status: 403 };
  return found;
}
