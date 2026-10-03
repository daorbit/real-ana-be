export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function bareDomain(input: string): string {
  return String(input ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/^www\./, "")
    .toLowerCase();
}

export function brandTokens(domain: string): string[] {
  const label = bareDomain(domain).split(".")[0] ?? "";
  if (label.length < 3) return [];
  const spaced = label.replace(/[-_]+/g, " ");
  return [...new Set([label, spaced, spaced.replace(/\s+/g, "")])];
}

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|msclkid$|mc_|ref$|ref_src$|igshid$|si$)/i;

export function cleanSourceUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}
