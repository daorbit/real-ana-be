import { Router, Response } from "express";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { resolveBranding, saveBranding } from "../../modules/branding/branding.service.js";

/**
 * How a workspace presents itself on anything its customers see — payment
 * windows, public forms, notification emails.
 *
 * Mounted under `/api/workspaces/:wid/branding`. Reading is open to any
 * member, since the rest of the dashboard needs it to render previews; writing
 * is admin-only, the same bar as billing, because it is the workspace's public
 * face rather than one person's view of it.
 */
const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

router.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res);
    if (!ws) return;
    res.json(await resolveBranding(String(ws.id)));
  }),
);

/**
 * Update the branding.
 *
 * A workspace whose plan does not include branding is refused here rather than
 * having its edit quietly dropped — the settings screen already knows from
 * `editable`, so a request arriving anyway is a client that skipped the check,
 * and telling it so is more use than pretending the save worked.
 */
router.put(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "admin");
    if (!ws) return;

    const current = await resolveBranding(String(ws.id));
    if (!current.editable) {
      return res.status(402).json({
        error: "Custom branding is part of the Pro plan.",
        code: "plan_required",
        kind: "form_branding",
      });
    }

    const body = req.body ?? {};
    const str = (value: unknown) => (typeof value === "string" ? value : undefined);

    res.json(
      await saveBranding(String(ws.id), {
        name: str(body.name),
        logoUrl: str(body.logoUrl),
        accentColor: str(body.accentColor),
        hidePoweredBy:
          typeof body.hidePoweredBy === "boolean" ? body.hidePoweredBy : undefined,
      }),
    );
  }),
);

export default router;
