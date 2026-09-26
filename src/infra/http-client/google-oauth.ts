import axios, { AxiosError } from "axios";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const GOOGLE_TIMEOUT_MS = 15_000;

export type GoogleClientConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type GoogleErrorKind =
  | "revoked"
  | "quota"
  | "not_enabled"
  | "forbidden"
  | "not_found"
  | "unavailable"
  | "unknown";

export class GoogleApiError extends Error {
  readonly kind: GoogleErrorKind;
  readonly status: number;

  constructor(kind: GoogleErrorKind, status: number, message: string) {
    super(message);
    this.name = "GoogleApiError";
    this.kind = kind;
    this.status = status;
  }
}

export function classifyGoogleError(err: unknown): GoogleApiError {
  if (err instanceof GoogleApiError) return err;
  if (!axios.isAxiosError(err)) {
    return new GoogleApiError("unknown", 500, err instanceof Error ? err.message : "request failed");
  }

  const axiosErr = err as AxiosError<{
    error?: {
      status?: string;
      message?: string;
      details?: Array<{ reason?: string }>;
      errors?: Array<{ reason?: string }>;
    };
  }>;

  const status = axiosErr.response?.status ?? 0;
  const body = axiosErr.response?.data?.error;
  const message = body?.message ?? axiosErr.message ?? "Google request failed";

  const reasons = [
    ...(body?.details ?? []).map((d) => d.reason ?? ""),
    ...(body?.errors ?? []).map((e) => e.reason ?? ""),
    body?.status ?? "",
  ]
    .join(" ")
    .toUpperCase();

  if (status === 401) return new GoogleApiError("revoked", 401, message);

  if (status === 429 || reasons.includes("RATE_LIMIT") || reasons.includes("QUOTA_EXCEEDED"))
    return new GoogleApiError("quota", 429, message);

  if (status === 403) {
    if (
      reasons.includes("SERVICE_DISABLED") ||
      reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") ||
      reasons.includes("API_NOT_ENABLED") ||
      /has not been used in project|is disabled/i.test(message)
    )
      return new GoogleApiError("not_enabled", 403, message);

    if (/quota/i.test(message)) return new GoogleApiError("quota", 429, message);

    return new GoogleApiError("forbidden", 403, message);
  }

  if (status === 404) return new GoogleApiError("not_found", 404, message);
  if (status >= 500 || status === 0) return new GoogleApiError("unavailable", 503, message);

  return new GoogleApiError("unknown", status || 500, message);
}

export async function googleGetJson<T>(
  url: string,
  accessToken: string,
  params?: Record<string, unknown>,
): Promise<T> {
  try {
    const { data } = await axios.get<T>(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params,
      timeout: GOOGLE_TIMEOUT_MS,
    });
    return data;
  } catch (err) {
    throw classifyGoogleError(err);
  }
}

export async function googlePostJson<T>(url: string, accessToken: string, body: unknown): Promise<T> {
  try {
    const { data } = await axios.post<T>(url, body, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: GOOGLE_TIMEOUT_MS,
    });
    return data;
  } catch (err) {
    throw classifyGoogleError(err);
  }
}

export function buildGoogleAuthorizeUrl(
  config: GoogleClientConfig,
  scope: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export type GoogleTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope: string;
  idToken?: string;
};

function tokensFrom(data: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}): GoogleTokens {
  const lifetime = Number(data.expires_in ?? 3600);
  return {
    accessToken: String(data.access_token ?? ""),
    refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
    expiresAt: new Date(Date.now() + Math.max(lifetime - 60, 60) * 1000),
    scope: String(data.scope ?? ""),
    idToken: data.id_token ? String(data.id_token) : undefined,
  };
}

export async function exchangeGoogleCode(
  config: GoogleClientConfig,
  code: string,
): Promise<GoogleTokens> {
  try {
    const { data } = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      }),
      { timeout: GOOGLE_TIMEOUT_MS, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    const tokens = tokensFrom(data);
    if (!tokens.accessToken) throw new GoogleApiError("unknown", 502, "Google returned no access token");
    return tokens;
  } catch (err) {
    throw classifyGoogleError(err);
  }
}

export async function refreshGoogleToken(
  config: GoogleClientConfig,
  refreshToken: string,
): Promise<GoogleTokens> {
  try {
    const { data } = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
      }),
      { timeout: GOOGLE_TIMEOUT_MS, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    return tokensFrom(data);
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const reason = String(
        (err.response?.data as { error?: string } | undefined)?.error ?? "",
      );
      if (reason === "invalid_grant" || reason === "invalid_client")
        throw new GoogleApiError("revoked", 401, "Google authorisation was revoked");
    }
    throw classifyGoogleError(err);
  }
}

export async function revokeGoogleToken(token: string, label = "google"): Promise<void> {
  try {
    await axios.post(REVOKE_URL, new URLSearchParams({ token }), {
      timeout: GOOGLE_TIMEOUT_MS,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } catch (err) {
    console.warn(`[${label}] revoke failed:`, err instanceof Error ? err.message : err);
  }
}
