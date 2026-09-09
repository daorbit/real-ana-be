import mongoose from "mongoose";
import { Branding } from "./models/Branding.js";
import { currentPlan } from "../billing/quota.service.js";
import { getPlanCatalogEntry } from "../billing/plans.catalog.js";

 
export const DEFAULT_BRAND_NAME = process.env.BRAND_NAME?.trim() || "Quantalog";

 
export const DEFAULT_BRAND_LOGO =
  process.env.BRAND_LOGO_URL?.trim() ||
  "https://studio-quantalog.daorbit.in/favicon.png";
export const POWERED_BY_LABEL =
  process.env.BRAND_POWERED_BY?.trim() || "Powered by Quantalog Forms";

 
export interface ResolvedBranding {
  name: string;
  logoUrl?: string;
  accentColor?: string;
  /** False once a paying workspace has switched the caption off. */
  showPoweredBy: boolean;
  /** The caption itself, so callers do not each spell it differently. */
  poweredByLabel: string;
  /** Whether this plan may override any of the above. */
  editable: boolean;
  /** What the workspace stored, regardless of whether its plan honours it. */
  stored: {
    name?: string;
    logoUrl?: string;
    accentColor?: string;
    hidePoweredBy: boolean;
  };
}

 
export async function resolveBranding(workspaceId: string): Promise<ResolvedBranding> {
  const [stored, plan] = await Promise.all([
    mongoose.isValidObjectId(workspaceId)
      ? Branding.findOne({ workspaceId }).lean<{
          name?: string;
          logoUrl?: string;
          accentColor?: string;
          hidePoweredBy?: boolean;
        }>()
      : null,
    currentPlan(workspaceId).catch(() => null),
  ]);

  const entry = plan ?? getPlanCatalogEntry("free");
  const editable = Boolean(entry?.formBranding);

  const storedView = {
    name: stored?.name?.trim() || undefined,
    logoUrl: stored?.logoUrl?.trim() || undefined,
    accentColor: stored?.accentColor?.trim() || undefined,
    hidePoweredBy: Boolean(stored?.hidePoweredBy),
  };

  return {
    name: (editable && storedView.name) || DEFAULT_BRAND_NAME,
    logoUrl: (editable && storedView.logoUrl) || DEFAULT_BRAND_LOGO,
    accentColor: editable ? storedView.accentColor : undefined,
    showPoweredBy: !(editable && storedView.hidePoweredBy),
    poweredByLabel: POWERED_BY_LABEL,
    editable,
    stored: storedView,
  };
}

export interface BrandingInput {
  name?: string;
  logoUrl?: string;
  accentColor?: string;
  hidePoweredBy?: boolean;
}

/**
 * Store a workspace's branding.
 *
 * Written whatever the plan allows — see the model's note on `hidePoweredBy`.
 * Callers that need to refuse the edit outright check `editable` first; this
 * function's job is to remember, not to judge.
 *
 * An empty string clears a field rather than storing blankness, so "remove my
 * logo" and "I never set one" end up the same shape.
 */
export async function saveBranding(
  workspaceId: string,
  input: BrandingInput,
): Promise<ResolvedBranding> {
  const set: Record<string, unknown> = {};
  const unset: Record<string, "">
    = {};

  for (const field of ["name", "logoUrl", "accentColor"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed) set[field] = trimmed;
    else unset[field] = "";
  }
  if (input.hidePoweredBy !== undefined) set.hidePoweredBy = input.hidePoweredBy;

  await Branding.findOneAndUpdate(
    { workspaceId },
    {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
      $setOnInsert: { workspaceId },
    },
    { upsert: true, new: true },
  );

  return resolveBranding(workspaceId);
}
