import { Router, type Response } from "express";
import { requireMcpToken, type McpRequest } from "../middleware/mcp-auth.js";
import { limitByIp } from "../middleware/mcp-guards.js";

const router = Router();
const MCP_PATHS = ["/", "/:workspaceId", "/:workspaceId/:client"];

router.post(
  MCP_PATHS,
  limitByIp("mcp", 300, 60_000),
  requireMcpToken,
  async (req: McpRequest, res: Response) => {
    const { handleMcpRequest } = await import("../../modules/mcp/server.js");
    await handleMcpRequest(req, res, req.mcpAuth!);
  },
);

router.all(MCP_PATHS, (_req, res) => {
  res.set("Allow", "POST");
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

export default router;
