export function changePct(current: number, previous: number): number | null {
  return previous > 0 ? Math.round(((current - previous) / previous) * 100) : null;
}

export function ratePct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

export const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

export const pctText = (n: number) => `${Math.round(n * 10) / 10}%`;

export function displayPath(host: string, path: string, multiHost: boolean): string {
  return multiHost && host ? `${host}${path}` : path;
}

export function normaliseHost(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./i, "")
    .toLowerCase();
}

export function normalisePath(value: string): string {
  const path = (value || "/").split(/[?#]/)[0];
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : "/";
}
