import axios, { AxiosError } from "axios";

 

const ACCOUNTS_API = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFO_API = "https://mybusinessbusinessinformation.googleapis.com/v1";
const REVIEWS_API = "https://mybusiness.googleapis.com/v4";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

 
export const BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";

const TIMEOUT_MS = 15_000;

 
function clientId(): string {
  return process.env.GOOGLE_GBP_CLIENT_ID ?? "";
}

function clientSecret(): string {
  return process.env.GOOGLE_GBP_CLIENT_SECRET ?? "";
}

export function googleBusinessRedirectUri(): string {
  return (
    process.env.GOOGLE_GBP_REDIRECT_URI ??
    `${process.env.PUBLIC_BASE_URL ?? "http://localhost:4000"}/api/auth/google-business/callback`
  );
}

 
export function missingGoogleBusinessConfig(): string[] {
  const missing: string[] = [];
  if (!clientId()) missing.push("GOOGLE_GBP_CLIENT_ID");
  if (!clientSecret()) missing.push("GOOGLE_GBP_CLIENT_SECRET");
  if (!googleBusinessRedirectUri()) missing.push("GOOGLE_GBP_REDIRECT_URI");
  return missing;
}

export function googleBusinessConfigured(): boolean {
  return missingGoogleBusinessConfig().length === 0;
}

 
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

 
function classify(err: unknown): GoogleApiError {
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

  // Reasons appear in either shape depending on which of the three hosts
  // answered, so both are collected before matching.
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

    // A 403 naming a quota metric is exhaustion, not permission — and on a
    // zero-quota project this is what "not approved yet" actually looks like.
    if (/quota/i.test(message)) return new GoogleApiError("quota", 429, message);

    return new GoogleApiError("forbidden", 403, message);
  }

  if (status === 404) return new GoogleApiError("not_found", 404, message);
  if (status >= 500 || status === 0) return new GoogleApiError("unavailable", 503, message);

  return new GoogleApiError("unknown", status || 500, message);
}

/** Every Google call funnels through here so classification is never skipped. */
async function getJson<T>(url: string, accessToken: string, params?: Record<string, unknown>): Promise<T> {
  try {
    const { data } = await axios.get<T>(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params,
      timeout: TIMEOUT_MS,
    });
    return data;
  } catch (err) {
    throw classify(err);
  }
}

 
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: googleBusinessRedirectUri(),
    response_type: "code",
    scope: BUSINESS_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export type GoogleTokens = {
  accessToken: string;
  /** Absent when Google declines to reissue one; the stored token stays valid. */
  refreshToken?: string;
  expiresAt: Date;
  scope: string;
  /**
   * Google's signed assertion of who authorised, when the granted scopes
   * include identity ones.
   *
   * Present only if the user has also signed in with Google, since
   * `include_granted_scopes` carries those across. Used solely to label the
   * connection with an email address in the dashboard — never as a credential,
   * and the flow succeeds without it.
   */
  idToken?: string;
};

function tokensFrom(data: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}): GoogleTokens {
  // Google's `expires_in` is seconds. A 60-second haircut means a token is
  // treated as expired slightly early, so a request never starts with one that
  // dies mid-flight.
  const lifetime = Number(data.expires_in ?? 3600);
  return {
    accessToken: String(data.access_token ?? ""),
    refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
    expiresAt: new Date(Date.now() + Math.max(lifetime - 60, 60) * 1000),
    scope: String(data.scope ?? ""),
    idToken: data.id_token ? String(data.id_token) : undefined,
  };
}

/** Exchange the one-time code from the callback for tokens. */
export async function exchangeCodeForTokens(code: string): Promise<GoogleTokens> {
  try {
    const { data } = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        code,
        client_id: clientId(),
        client_secret: clientSecret(),
        redirect_uri: googleBusinessRedirectUri(),
        grant_type: "authorization_code",
      }),
      { timeout: TIMEOUT_MS, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    const tokens = tokensFrom(data);
    if (!tokens.accessToken) throw new GoogleApiError("unknown", 502, "Google returned no access token");
    return tokens;
  } catch (err) {
    if (err instanceof GoogleApiError) throw err;
    throw classify(err);
  }
}

 
export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  try {
    const { data } = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId(),
        client_secret: clientSecret(),
        grant_type: "refresh_token",
      }),
      { timeout: TIMEOUT_MS, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
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
    throw classify(err);
  }
}

 
export async function revokeToken(token: string): Promise<void> {
  try {
    await axios.post(REVOKE_URL, new URLSearchParams({ token }), {
      timeout: TIMEOUT_MS,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } catch (err) {
    console.warn(
      "[google-business] revoke failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

 
export type GoogleAccount = {
  name: string;
  accountName: string;
  type: string;
};

 
export async function listAccounts(accessToken: string): Promise<GoogleAccount[]> {
  const out: GoogleAccount[] = [];
  let pageToken: string | undefined;

  do {
    const data = await getJson<{
      accounts?: Array<{ name?: string; accountName?: string; type?: string }>;
      nextPageToken?: string;
    }>(`${ACCOUNTS_API}/accounts`, accessToken, { pageSize: 20, pageToken });

    for (const account of data.accounts ?? []) {
      if (!account.name) continue;
      out.push({
        name: account.name,
        accountName: account.accountName ?? account.name,
        type: account.type ?? "",
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken && out.length < 200);

  return out;
}

export type GoogleLocationSummary = {
  /** Resource name, `locations/456`. */
  name: string;
  /** The bare id, `456` — what the v4 reviews path needs. */
  locationId: string;
  title: string;
  address: string;
};

 
function formatAddress(address?: {
  addressLines?: string[];
  locality?: string;
  administrativeArea?: string;
  postalCode?: string;
  regionCode?: string;
}): string {
  if (!address) return "";
  return [
    ...(address.addressLines ?? []),
    address.locality,
    address.administrativeArea,
    address.postalCode,
    address.regionCode,
  ]
    .filter((part) => part && String(part).trim())
    .join(", ");
}

 
export async function listLocations(
  accessToken: string,
  accountName: string,
): Promise<GoogleLocationSummary[]> {
  const out: GoogleLocationSummary[] = [];
  let pageToken: string | undefined;

  do {
    const data = await getJson<{
      locations?: Array<{
        name?: string;
        title?: string;
        storefrontAddress?: Parameters<typeof formatAddress>[0];
      }>;
      nextPageToken?: string;
    }>(`${INFO_API}/${accountName}/locations`, accessToken, {
      readMask: "name,title,storefrontAddress",
      pageSize: 100,
      pageToken,
    });

    for (const location of data.locations ?? []) {
      if (!location.name) continue;
      out.push({
        name: location.name,
        locationId: location.name.split("/").pop() ?? location.name,
        title: location.title ?? "Untitled location",
        address: formatAddress(location.storefrontAddress),
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken && out.length < 500);

  return out;
}
 
const STAR_VALUES: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

export type GoogleReviewPayload = {
  reviewId: string;
  reviewerName: string;
  reviewerPhoto: string;
  rating: number;
  comment: string;
  createTime: Date | null;
  updateTime: Date | null;
  reply: { comment: string; updateTime: Date | null } | null;
  /** The untouched Google object, kept for fields this app does not model yet. */
  raw: Record<string, unknown>;
};

export type ReviewPage = {
  reviews: GoogleReviewPayload[];
  averageRating: number;
  totalReviewCount: number;
};

function toDate(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

 
export async function listReviews(
  accessToken: string,
  accountId: string,
  locationId: string,
  pageLimit = 20,
): Promise<ReviewPage> {
  const reviews: GoogleReviewPayload[] = [];
  let pageToken: string | undefined;
  let averageRating = 0;
  let totalReviewCount = 0;
  let pages = 0;

  do {
    const data = await getJson<{
      reviews?: Array<{
        reviewId?: string;
        reviewer?: { displayName?: string; profilePhotoUrl?: string };
        starRating?: string;
        comment?: string;
        createTime?: string;
        updateTime?: string;
        reviewReply?: { comment?: string; updateTime?: string };
      }>;
      averageRating?: number;
      totalReviewCount?: number;
      nextPageToken?: string;
    }>(
      `${REVIEWS_API}/accounts/${accountId}/locations/${locationId}/reviews`,
      accessToken,
      { pageSize: 50, pageToken },
    );

    // Both totals describe the whole location, not the page, so the first
    // page's values are the authoritative ones.
    if (pages === 0) {
      averageRating = Number(data.averageRating ?? 0);
      totalReviewCount = Number(data.totalReviewCount ?? 0);
    }

    for (const review of data.reviews ?? []) {
      if (!review.reviewId) continue;
      reviews.push({
        reviewId: review.reviewId,
        reviewerName: review.reviewer?.displayName?.trim() || "A Google user",
        reviewerPhoto: review.reviewer?.profilePhotoUrl ?? "",
        rating: STAR_VALUES[String(review.starRating ?? "")] ?? 0,
        comment: review.comment ?? "",
        createTime: toDate(review.createTime),
        updateTime: toDate(review.updateTime),
        reply: review.reviewReply
          ? {
              comment: review.reviewReply.comment ?? "",
              updateTime: toDate(review.reviewReply.updateTime),
            }
          : null,
        raw: review as Record<string, unknown>,
      });
    }

    pageToken = data.nextPageToken;
    pages += 1;
  } while (pageToken && pages < pageLimit);

  return { reviews, averageRating, totalReviewCount };
}
