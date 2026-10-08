import { Workspace } from "./models/Workspace.js";
import { checkImageDataUrl, cloudinaryConfigured, deleteImage, uploadImage } from "../../infra/storage/cloudinary.js";

export const MAX_NAV_LINKS = 10;
const MAX_NAV_PATHS = 60;
const MAX_LOGO_BYTES = 1024 * 1024;
const LOCKED_PATHS = new Set(["/app", "/app/settings"]);

type StoredLink = { id: string; label: string; url: string; logoUrl?: string; logoPublicId?: string };
type StoredPrefs = { hidden?: string[]; pinned?: string[]; links?: StoredLink[] } | null | undefined;
type WorkspaceDocument = InstanceType<typeof Workspace>;

export interface PublicNavPrefs {
  hidden: string[];
  pinned: string[];
  links: { id: string; label: string; url: string; logoUrl: string }[];
}

export class NavPrefsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function toPublicNavPrefs(prefs: StoredPrefs): PublicNavPrefs | null {
  if (!prefs) return null;
  return {
    hidden: [...(prefs.hidden ?? [])],
    pinned: [...(prefs.pinned ?? [])],
    links: (prefs.links ?? []).map((l) => ({ id: l.id, label: l.label, url: l.url, logoUrl: l.logoUrl ?? "" })),
  };
}

const appPaths = (v: unknown): string[] =>
  Array.isArray(v)
    ? [
        ...new Set(
          v.filter((p): p is string => typeof p === "string" && p.length <= 80 && /^\/app(\/[\w-]+)*$/.test(p)),
        ),
      ].slice(0, MAX_NAV_PATHS)
    : [];

function httpUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    const url = new URL(v.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function storedLinks(ws: WorkspaceDocument): StoredLink[] {
  return ((ws.get("navPrefs") as StoredPrefs)?.links ?? []).map((l) => ({
    id: l.id,
    label: l.label,
    url: l.url,
    logoUrl: l.logoUrl ?? "",
    logoPublicId: l.logoPublicId ?? "",
  }));
}

function parseLinks(v: unknown, previous: StoredLink[]): StoredLink[] {
  if (!Array.isArray(v)) return [];
  const before = new Map(previous.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const out: StoredLink[] = [];

  for (const raw of v) {
    if (out.length >= MAX_NAV_LINKS) break;
    if (!raw || typeof raw !== "object") continue;
    const { id, label, url } = raw as Record<string, unknown>;
    if (typeof id !== "string" || !/^[\w-]{4,40}$/.test(id) || seen.has(id)) continue;
    const cleanUrl = httpUrl(url);
    const cleanLabel = typeof label === "string" ? label.trim().slice(0, 40) : "";
    if (!cleanUrl || !cleanLabel) continue;
    seen.add(id);
    const prior = before.get(id);
    out.push({ id, label: cleanLabel, url: cleanUrl, logoUrl: prior?.logoUrl ?? "", logoPublicId: prior?.logoPublicId ?? "" });
  }
  return out;
}

const publicOf = (ws: WorkspaceDocument) => toPublicNavPrefs(ws.get("navPrefs") as StoredPrefs);

export async function saveNavPrefs(ws: WorkspaceDocument, body: unknown): Promise<PublicNavPrefs | null> {
  const input = (body ?? {}) as Record<string, unknown>;
  const previous = storedLinks(ws);
  const links = parseLinks(input.links, previous);
  const kept = new Set(links.map((l) => l.logoPublicId).filter(Boolean));

  ws.set("navPrefs", {
    hidden: appPaths(input.hidden).filter((p) => !LOCKED_PATHS.has(p)),
    pinned: appPaths(input.pinned),
    links,
  });
  await ws.save();

  previous.forEach((l) => {
    if (l.logoPublicId && !kept.has(l.logoPublicId)) void deleteImage(l.logoPublicId);
  });

  return publicOf(ws);
}

export async function setNavLinkLogo(ws: WorkspaceDocument, linkId: string, dataUrl: string): Promise<PublicNavPrefs | null> {
  if (!cloudinaryConfigured()) throw new NavPrefsError("image uploads are not configured", 503);
  const checked = checkImageDataUrl(dataUrl, MAX_LOGO_BYTES);
  if ("error" in checked) throw new NavPrefsError(checked.error, 400);

  const links = storedLinks(ws);
  const link = links.find((l) => l.id === linkId);
  if (!link) throw new NavPrefsError("link not found", 404);

  const previousId = link.logoPublicId;
  const { url, publicId } = await uploadImage({
    file: dataUrl,
    folder: "quantalog-nav-links",
    publicId: `navlink-${ws.id}-${linkId}-${Date.now()}`,
    transformation: "c_pad,h_96,w_96,b_transparent/q_auto",
  });

  link.logoUrl = url;
  link.logoPublicId = publicId;
  ws.set("navPrefs.links", links);
  await ws.save();

  if (previousId) void deleteImage(previousId);
  return publicOf(ws);
}

export async function clearNavLinkLogo(ws: WorkspaceDocument, linkId: string): Promise<PublicNavPrefs | null> {
  const links = storedLinks(ws);
  const link = links.find((l) => l.id === linkId);
  if (!link) throw new NavPrefsError("link not found", 404);

  const previousId = link.logoPublicId;
  link.logoUrl = "";
  link.logoPublicId = "";
  ws.set("navPrefs.links", links);
  await ws.save();

  if (previousId) void deleteImage(previousId);
  return publicOf(ws);
}
