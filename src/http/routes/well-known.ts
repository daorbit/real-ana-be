import { Router, type Response } from "express";
import { authorizationServerMetadata, protectedResourceMetadata } from "../../modules/mcp-oauth/metadata.js";
import { endpointFromParams } from "../../modules/mcp-oauth/config.js";

const router = Router();

function cacheable(res: Response) {
  res.set("Cache-Control", "public, max-age=3600");
}

router.get(
  [
    "/oauth-authorization-server",
    "/oauth-authorization-server/mcp",
    "/oauth-authorization-server/mcp/:workspaceId",
    "/oauth-authorization-server/mcp/:workspaceId/:client",
  ],
  (_req, res) => {
    cacheable(res);
    res.json(authorizationServerMetadata());
  },
);

router.get(
  [
    "/oauth-protected-resource",
    "/oauth-protected-resource/mcp",
    "/oauth-protected-resource/mcp/:workspaceId",
    "/oauth-protected-resource/mcp/:workspaceId/:client",
  ],
  (req, res) => {
    const endpoint = endpointFromParams(req.params);
    if (!endpoint) return res.status(404).json({ error: "not found" });
    cacheable(res);
    res.json(protectedResourceMetadata(endpoint));
  },
);

export default router;
