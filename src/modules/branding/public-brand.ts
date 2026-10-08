import { createTtlCache } from "../../shared/utils/ttl-cache.js";
import { resolveBranding } from "./branding.service.js";

export interface PublicBrand {
  name: string | null;
  logoUrl: string | null;
  accentColor: string | null;
  showPoweredBy: boolean;
}

const HEX = /^#[0-9a-f]{6}$/i;

const cache = createTtlCache<PublicBrand>(60_000, 1_000);

export function publicBrand(workspaceId: string): Promise<PublicBrand> {
  return cache(workspaceId, async () => {
    const b = await resolveBranding(workspaceId);
    return {
      name: b.header?.name ?? null,
      logoUrl: b.header?.logoUrl ?? null,
      accentColor: b.accentColor && HEX.test(b.accentColor) ? b.accentColor : null,
      showPoweredBy: b.showPoweredBy,
    };
  });
}
