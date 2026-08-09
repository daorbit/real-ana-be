import { Site } from "../../modules/analytics/models/Site.js";
import { AuthedRequest } from "../middleware/auth.js";
import { resolveAccess, isDenied, type Access } from "../../modules/workspace/access.service.js";
import type { WorkspaceRole } from "../../modules/workspace/models/Membership.js";

/**
 * Resolving `:wid/sites/:siteId` to a workspace and site the caller may use.
 *
 * Shared by every route module scoped to one site, so the SEO routes and the
 * competitor routes cannot drift apart on what counts as access — the check
 * that refuses a viewer a write is the same code in both.
 */

// Taken from `Access` rather than from the model's own query return type: the
// latter widens to `{}` here, which silently loses `.id` at every call site.
export type WorkspaceDoc = Access["workspace"];
export type SiteDoc = NonNullable<Awaited<ReturnType<typeof Site.findOne>>>;

/** Either the site and its workspace, or a refusal carrying the status to send. */
export type SiteRefused = { error: string; status: 403 | 404 };
export type SiteResult = { ws: WorkspaceDoc; site: SiteDoc } | SiteRefused;

/**
 * Narrowing helper. A plain `"error" in found` cannot discriminate here —
 * the refusal and the success branch are structurally unrelated, so the check
 * has to be a real type guard for the success branch's fields to survive it.
 */
export function siteRefused(result: SiteResult): result is SiteRefused {
  return "error" in result;
}

export async function resolveSite(
  req: AuthedRequest,
  minimum: WorkspaceRole = "viewer",
): Promise<SiteResult> {
  const access = await resolveAccess(req, minimum);
  // Carries the access layer's own status: a role refusal is a 403, while a
  // workspace the caller cannot see stays a 404. Collapsing both to 404 here
  // would tell an editor their own workspace had vanished.
  if (isDenied(access)) return { error: access.error, status: access.status as 403 | 404 };
  const site = await Site.findOne({ siteId: req.params.siteId, workspaceId: access.workspace.id });
  if (!site) return { error: "site not found", status: 404 as 403 | 404 };
  return { ws: access.workspace, site };
}
