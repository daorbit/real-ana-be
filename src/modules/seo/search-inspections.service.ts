import { hasQuota, spendQuota } from "../billing/quota.service.js";
import type { SiteRef } from "./search-cache.js";
import { getSearchInspection, isInspectionCached, type SearchInspection } from "./search-console.service.js";
import { SearchPlanDenied, type SearchEntitlement } from "./search-entitlements.js";
import { indexCheckOf, saveIndexCheck } from "./search-index-checks.js";

function inspectionDenied(ent: SearchEntitlement): SearchPlanDenied {
  const limit = { kind: "search_inspections", label: "Google index checks", plan: ent.planName };
  return ent.inspectionQuota > 0
    ? new SearchPlanDenied(
        `You've used all ${ent.inspectionQuota} Google index checks this month. Upgrade for more.`,
        { ...limit, quota: ent.inspectionQuota },
        "quota_exceeded",
      )
    : new SearchPlanDenied("Checking a page's Google index status is included from the Starter plan.", limit);
}

export async function inspectPage(site: SiteRef, ent: SearchEntitlement, url: string): Promise<SearchInspection> {
  const alreadyPaid = await isInspectionCached(site, url);
  if (!alreadyPaid && !(await hasQuota(site.workspaceId, "inspection"))) throw inspectionDenied(ent);

  const inspection = await getSearchInspection(site, url);
  await Promise.all([
    alreadyPaid ? undefined : spendQuota(site.workspaceId, "inspection"),
    saveIndexCheck(site, indexCheckOf(inspection)),
  ]);
  return inspection;
}
