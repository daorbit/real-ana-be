import { Router, type Response } from "express";
import { authorizationServerMetadata, protectedResourceMetadata } from "../../modules/mcp-oauth/metadata.js";

const router = Router();

function cacheable(res: Response) {
  res.set("Cache-Control", "public, max-age=3600");
}

router.get(["/oauth-authorization-server", "/oauth-authorization-server/mcp"], (_req, res) => {
  cacheable(res);
  res.json(authorizationServerMetadata());
});

router.get(["/oauth-protected-resource", "/oauth-protected-resource/mcp"], (_req, res) => {
  cacheable(res);
  res.json(protectedResourceMetadata());
});

export default router;
