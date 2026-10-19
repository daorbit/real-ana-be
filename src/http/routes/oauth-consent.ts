import { Router, type Response } from "express";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { approveRequest, denyRequest, describeRequest } from "../../modules/mcp-oauth/authorize.service.js";
import { listUserGrants, revokeUserGrant } from "../../modules/mcp-oauth/grant.service.js";
import { recordAudit } from "../../modules/audit/audit.service.js";
import { resourceUrl } from "../../modules/mcp-oauth/config.js";
import { badRequest, forbidden, notFound } from "../../shared/errors/index.js";

const router = Router();
router.use(requireAuth);

function rejectBorrowedSessions(req: AuthedRequest) {
  if (req.isDemo) throw forbidden("demo sessions cannot connect AI apps");
  if (req.impersonatorId) throw forbidden("not available while impersonating");
}

function requestId(req: AuthedRequest): string {
  const raw = req.params.requestId;
  if (typeof raw !== "string" || !raw) throw badRequest("missing request id");
  return raw;
}

router.get("/requests/:requestId", async (req: AuthedRequest, res: Response) => {
  rejectBorrowedSessions(req);
  res.set("Cache-Control", "no-store");
  res.json(await describeRequest(requestId(req), String(req.userId)));
});

router.post("/requests/:requestId/approve", async (req: AuthedRequest, res: Response) => {
  rejectBorrowedSessions(req);
  const result = await approveRequest(requestId(req), String(req.userId), req.body?.workspaceId);
  await recordAudit(req, {
    action: "ai_connector.authorized",
    workspaceId: result.workspaceId,
    target: { kind: "ai_connector", label: result.clientName },
  });
  res.set("Cache-Control", "no-store");
  res.json({ redirectUrl: result.redirectUrl });
});

router.post("/requests/:requestId/deny", async (req: AuthedRequest, res: Response) => {
  rejectBorrowedSessions(req);
  res.set("Cache-Control", "no-store");
  res.json(await denyRequest(requestId(req)));
});

router.get("/grants", async (req: AuthedRequest, res: Response) => {
  res.json({ items: await listUserGrants(String(req.userId)), mcpUrl: resourceUrl() });
});

router.delete("/grants/:grantId", async (req: AuthedRequest, res: Response) => {
  if (req.isDemo) throw forbidden("demo mode is read-only");
  const revoked = await revokeUserGrant(String(req.userId), String(req.params.grantId));
  if (!revoked) throw notFound("connection not found");
  await recordAudit(req, {
    action: "ai_connector.revoked",
    workspaceId: revoked.workspaceId,
    target: { kind: "ai_connector", label: revoked.clientName },
  });
  res.status(204).end();
});

export default router;
