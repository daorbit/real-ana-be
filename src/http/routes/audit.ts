import { Router, Response } from "express";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { resolveAccess, isDenied } from "../../modules/workspace/access.service.js";
import {
  workspaceAuditPage,
  workspaceAuditSummary,
  parseCursor,
  parsePage,
} from "../../modules/audit/audit.service.js";
import { auditWindow } from "../../modules/audit/retention.js";
import { isAuditCategory } from "../../modules/audit/actions.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

router.get("/", async (req: AuthedRequest, res: Response) => {
  const cursor = parseCursor(req.query.cursor);
  if (cursor === null) return res.status(400).json({ error: "cursor must be a valid date" });
  const pageNumber = parsePage(req.query.page);
  if (pageNumber === null) return res.status(400).json({ error: "page must be a positive whole number" });
  const firstPage = pageNumber ? pageNumber === 1 : !cursor;

  const category = isAuditCategory(req.query.category) ? req.query.category : undefined;
  const actorId = typeof req.query.actor === "string" ? req.query.actor : undefined;

  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  const window = await auditWindow(access.workspace.id);
  const [page, summary] = await Promise.all([
    workspaceAuditPage(access.workspace.id, {
      since: window.since,
      cursor,
      category,
      actorId,
      page: pageNumber,
      limit: Number(req.query.limit) || undefined,
    }),
    firstPage ? workspaceAuditSummary(access.workspace.id, window.since) : null,
  ]);

  res.json({
    ...page,
    summary,
    retention: { days: window.days, plan: window.plan, upgradable: window.upgradable },
  });
});

export default router;
