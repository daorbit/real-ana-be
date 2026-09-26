import {
  GoogleApiError,
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  googleGetJson,
  refreshGoogleToken,
  revokeGoogleToken,
  type GoogleClientConfig,
  type GoogleTokens,
} from "./google-oauth.js";

export { GoogleApiError };
export type { GoogleErrorKind, GoogleTokens } from "./google-oauth.js";

const ACCOUNTS_API = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFO_API = "https://mybusinessbusinessinformation.googleapis.com/v1";
const REVIEWS_API = "https://mybusiness.googleapis.com/v4";


export const BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";


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

function config(): GoogleClientConfig {
  return {
    clientId: clientId(),
    clientSecret: clientSecret(),
    redirectUri: googleBusinessRedirectUri(),
  };
}

const getJson = googleGetJson;

export function buildAuthorizeUrl(state: string): string {
  return buildGoogleAuthorizeUrl(config(), BUSINESS_SCOPE, state);
}

/** Exchange the one-time code from the callback for tokens. */
export function exchangeCodeForTokens(code: string): Promise<GoogleTokens> {
  return exchangeGoogleCode(config(), code);
}

export function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  return refreshGoogleToken(config(), refreshToken);
}

export function revokeToken(token: string): Promise<void> {
  return revokeGoogleToken(token, "google-business");
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
