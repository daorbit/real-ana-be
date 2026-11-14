import type { BioPage } from "./models/BioPage.js";

type BioPageDoc = InstanceType<typeof BioPage>;
type RawLink = { _id: unknown; label: string; url: string; enabled?: boolean };
type RawSocial = { _id?: unknown; network: string; url: string; label?: string };
type RawRow = { _id: unknown; service: string; name: string; url: string; action: string; enabled?: boolean };
type RawRelease = { artworkUrl?: string; subtitle?: string; releaseDate?: string; rows?: RawRow[] } | null;

export type BioPageStats = { views: number; clicks: number; linkClicks: Record<string, number> };

export type BioTheme = {
  appearance: string;
  accent: string;
  buttonStyle: string;
  background: string;
  layout: string;
  font: string;
};

export type PresentedRow = { id: string; service: string; name: string; url: string; action: string; enabled: boolean };

export type PublicBioPage = {
  id: string;
  kind: string;
  slug: string;
  title: string;
  bio: string;
  avatarUrl: string;
  links: Array<{ id: string; label: string; url: string }>;
  socials: Array<{ id: string; network: string; url: string; label: string }>;
  release: {
    artworkUrl: string;
    subtitle: string;
    releaseDate: string;
    rows: Array<Omit<PresentedRow, "enabled">>;
  } | null;
  theme: BioTheme;
};

function themeOf(doc: BioPageDoc, kind: string): BioTheme {
  return {
    appearance: (doc.get("theme.appearance") as string) ?? "light",
    accent: (doc.get("theme.accent") as string) ?? "#1d1d1f",
    buttonStyle: (doc.get("theme.buttonStyle") as string) ?? "rounded",
    background: (doc.get("theme.background") as string) ?? "plain",
    layout: (doc.get("theme.layout") as string) ?? (kind === "release" ? "list" : "classic"),
    font: (doc.get("theme.font") as string) ?? "sans",
  };
}

function releaseOf(doc: BioPageDoc) {
  const release = doc.get("release") as RawRelease;
  if (!release) return null;
  return {
    artworkUrl: release.artworkUrl ?? "",
    subtitle: release.subtitle ?? "",
    releaseDate: release.releaseDate ?? "",
    rows: (release.rows ?? []).map((row) => ({
      id: String(row._id),
      service: row.service,
      name: row.name,
      url: row.url,
      action: row.action,
      enabled: row.enabled !== false,
    })),
  };
}

export function presentBioPage(doc: BioPageDoc, stats?: BioPageStats) {
  const kind = (doc.get("kind") as string) ?? "profile";
  return {
    id: doc.id as string,
    kind,
    slug: doc.get("slug") as string,
    title: doc.get("title") as string,
    bio: (doc.get("bio") as string) ?? "",
    avatarUrl: (doc.get("avatarUrl") as string) ?? "",
    links: ((doc.get("links") as RawLink[]) ?? []).map((link) => ({
      id: String(link._id),
      label: link.label,
      url: link.url,
      enabled: link.enabled !== false,
    })),
    socials: ((doc.get("socials") as RawSocial[]) ?? []).map((s, i) => ({
      id: s._id ? String(s._id) : `${s.network}-${i}`,
      network: s.network,
      url: s.url,
      label: s.label ?? "",
    })),
    release: kind === "release" ? releaseOf(doc) : null,
    theme: themeOf(doc, kind),
    published: doc.get("published") as boolean,
    stats: stats ?? { views: 0, clicks: 0, linkClicks: {} },
    updatedAt: doc.get("updatedAt") as Date,
  };
}

export function toPublicBioPage(present: ReturnType<typeof presentBioPage>): PublicBioPage {
  return {
    id: present.id,
    kind: present.kind,
    slug: present.slug,
    title: present.title,
    bio: present.bio,
    avatarUrl: present.avatarUrl,
    links: present.links.filter((link) => link.enabled).map(({ id, label, url }) => ({ id, label, url })),
    socials: present.socials,
    release: present.release
      ? {
          artworkUrl: present.release.artworkUrl,
          subtitle: present.release.subtitle,
          releaseDate: present.release.releaseDate,
          rows: present.release.rows.filter((row) => row.enabled).map(({ id, service, name, url, action }) => ({ id, service, name, url, action })),
        }
      : null,
    theme: present.theme,
  };
}

export function trackedIds(page: PublicBioPage): Set<string> {
  return new Set([...page.links.map((l) => l.id), ...(page.release?.rows ?? []).map((r) => r.id)]);
}
