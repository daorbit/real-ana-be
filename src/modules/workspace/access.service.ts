import { Workspace } from "./models/Workspace.js";
import { Membership, ROLE_RANK, type WorkspaceRole } from "./models/Membership.js";
import type { AuthedRequest } from "../../http/middleware/auth.js";

/**
 * Who may do what inside a workspace.
 *
 * Every route that touches workspace data goes through `resolveAccess` (or one
 * of the thin wrappers below) instead of querying `Workspace.findOne({ _id,
 * userId })` itself. That old pattern conflated two questions — "does this
 * workspace exist" and "may this caller use it" — and answered both only for
 * the creator, which is exactly what has to change now that a workspace can be
 * shared.
 *
 * The role always comes from the `Membership` collection, never from the
 * request or the token: a token lives for days, and someone demoted from admin
 * to viewer this morning must not keep writing until it expires.
 */

export type Access = {
  workspace: InstanceType<typeof Workspace>;
  role: WorkspaceRole;
};

type Denied = { error: string; status: 403 | 404 };

/**
 * The caller's access to the workspace named by `:wid`, or a refusal.
 *
 * A workspace the caller is not a member of returns 404, not 403: a 403 would
 * confirm the id names a real workspace, which is a small directory of other
 * customers' ids to anyone willing to enumerate. Insufficient *role* within a
 * workspace they can already see is a genuine 403 — they know it exists, so
 * there is nothing left to leak.
 */
export async function resolveAccess(
  req: AuthedRequest,
  minimum: WorkspaceRole = "viewer",
  workspaceId?: string,
): Promise<Access | Denied> {
  const wid = workspaceId ?? req.params.wid;
  if (!wid) return { error: "workspace not found", status: 404 };

  const membership = await Membership.findOne({ workspaceId: wid, userId: req.userId });
  if (!membership) return { error: "workspace not found", status: 404 };

  const workspace = await Workspace.findById(wid);
  // Membership outliving its workspace shouldn't happen — deleting a workspace
  // removes them — but a dangling row must read as "gone", not crash the route.
  if (!workspace) return { error: "workspace not found", status: 404 };

  const role = membership.role as WorkspaceRole;
  if (ROLE_RANK[role] < ROLE_RANK[minimum])
    return {
      error: `this needs ${minimum} access to the workspace — you have ${role} access`,
      status: 403,
    };

  return { workspace, role };
}

/** Narrowing helper, so callers can write `if (isDenied(access))`. */
export function isDenied(result: Access | Denied): result is Denied {
  return "error" in result;
}

/**
 * `resolveAccess` for routes that already handle a missing workspace by
 * bailing out: it sends the refusal itself and returns null, so the call site
 * stays the one-line `if (!ws) return;` shape it already had.
 *
 * Returns the workspace on success rather than the whole `Access`, since these
 * callers only ever needed the document.
 */
export async function requireWorkspace(
  req: AuthedRequest,
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  minimum: WorkspaceRole = "viewer",
) {
  const access = await resolveAccess(req, minimum);
  if (isDenied(access)) {
    res.status(access.status).json({ error: access.error });
    return null;
  }
  return access.workspace;
}

/**
 * Every workspace the caller can reach, newest first.
 *
 * Driven by membership rather than `Workspace.userId`, so a workspace shared
 * with someone appears in their list exactly like one they created — which is
 * what makes the rest of the app work unchanged for a guest.
 */
export async function accessibleWorkspaces(userId: string) {
  const memberships = await Membership.find({ userId }).select("workspaceId role");
  const roleByWorkspace = new Map(
    memberships.map((m) => [String(m.workspaceId), m.role as WorkspaceRole]),
  );

  const workspaces = await Workspace.find({
    _id: { $in: memberships.map((m) => m.workspaceId) },
  }).sort({ createdAt: -1 });

  return workspaces.map((workspace) => ({
    workspace,
    role: roleByWorkspace.get(workspace.id) as WorkspaceRole,
  }));
}
