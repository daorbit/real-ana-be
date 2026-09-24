import { Response, NextFunction } from "express";
import { requireAuth, AuthedRequest } from "./auth.js";
import { findActiveKey } from "./api-key.js";
import { Workspace } from "../../modules/workspace/models/Workspace.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import type { WorkspaceRole } from "../../modules/workspace/models/Membership.js";

export interface OrbitRequest extends AuthedRequest {
  apiKeyId?: string;
  apiKeyWorkspaceId?: string;
}


export async function requireApiKeyOrAuth(
  req: OrbitRequest,
  res: Response,
  next: NextFunction,
) {
  const header = req.headers.authorization ?? "";
  const raw = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!raw || !raw.startsWith("sk_")) {
    return requireAuth(req, res, next);
  }

  const found = await findActiveKey(raw);
  if (!found.ok) return res.status(401).json({ error: found.error });
  const { key } = found;

  const workspace = await Workspace.findById(key.workspaceId).select("userId");
  if (!workspace) return res.status(401).json({ error: "invalid API key" });

  req.apiKeyId = key.id;
  req.apiKeyWorkspaceId = String(key.workspaceId);
  req.userId = String(workspace.get("userId"));
  next();
}


export async function requireWorkspaceEitherAuth(
  req: OrbitRequest,
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  minimum: WorkspaceRole = "viewer",
) {
  if (req.apiKeyId) {
    const wid = req.params.wid;

    if (!wid || wid !== req.apiKeyWorkspaceId) {
      res.status(404).json({ error: "workspace not found" });
      return null;
    }
    const workspace = await Workspace.findById(wid);
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return null;
    }
    return workspace;
  }

  return requireWorkspace(req, res, minimum);
}
