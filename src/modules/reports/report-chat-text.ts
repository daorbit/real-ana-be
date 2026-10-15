export function trend(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return "";
  if (delta === 0) return " (no change)";
  return ` (${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}%)`;
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

export function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/$/, "");
    return path.length > 40 ? `${path.slice(0, 37)}…` : path;
  } catch {
    return url.length > 40 ? `${url.slice(0, 37)}…` : url;
  }
}
