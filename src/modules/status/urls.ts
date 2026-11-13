const trim = (value: string) => value.replace(/\/+$/, "");

export function siteUrl(): string {
  return trim(process.env.PUBLIC_SITE_URL || "https://quantalog.daorbit.in");
}

export function apiUrl(): string {
  return trim(process.env.PUBLIC_BASE_URL || "https://quantalog-be.daorbit.in");
}

export function dashboardUrl(): string {
  return trim(process.env.PUBLIC_APP_URL || process.env.STUDIO_BASE_URL || "https://studio-quantalog.daorbit.in");
}

export function serviceUrl(value: string | undefined): string {
  return trim(value ?? "");
}
