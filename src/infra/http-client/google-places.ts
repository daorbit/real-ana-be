import axios from "axios";
import { GOOGLE_TIMEOUT_MS, classifyGoogleError } from "./google-oauth.js";
import { toDate, type GoogleReviewPayload, type ReviewPage } from "./google-business.js";

const PLACES_API = "https://places.googleapis.com/v1";

function apiKey(): string {
  return process.env.GOOGLE_PLACES_API_KEY ?? "";
}

export function placesConfigured(): boolean {
  return apiKey().length > 0;
}

export type PlaceResult = {
  placeId: string;
  title: string;
  address: string;
};

async function placesRequest<T>(
  method: "get" | "post",
  path: string,
  fieldMask: string,
  body?: unknown,
): Promise<T> {
  try {
    const { data } = await axios.request<T>({
      method,
      url: `${PLACES_API}${path}`,
      data: body,
      headers: { "X-Goog-Api-Key": apiKey(), "X-Goog-FieldMask": fieldMask },
      timeout: GOOGLE_TIMEOUT_MS,
    });
    return data;
  } catch (err) {
    throw classifyGoogleError(err);
  }
}

export async function searchPlaces(query: string): Promise<PlaceResult[]> {
  const data = await placesRequest<{
    places?: Array<{ id?: string; displayName?: { text?: string }; formattedAddress?: string }>;
  }>("post", "/places:searchText", "places.id,places.displayName,places.formattedAddress", {
    textQuery: query,
    pageSize: 8,
  });

  return (data.places ?? [])
    .filter((place) => place.id)
    .map((place) => ({
      placeId: String(place.id),
      title: place.displayName?.text ?? "Untitled place",
      address: place.formattedAddress ?? "",
    }));
}

export async function getPlaceReviews(placeId: string): Promise<ReviewPage> {
  const data = await placesRequest<{
    rating?: number;
    userRatingCount?: number;
    reviews?: Array<{
      name?: string;
      rating?: number;
      text?: { text?: string };
      originalText?: { text?: string };
      publishTime?: string;
      authorAttribution?: { displayName?: string; photoUri?: string };
    }>;
  }>("get", `/places/${encodeURIComponent(placeId)}`, "id,rating,userRatingCount,reviews");

  const reviews: GoogleReviewPayload[] = (data.reviews ?? [])
    .filter((review) => review.name)
    .map((review) => {
      const published = toDate(review.publishTime);
      return {
        reviewId: String(review.name),
        reviewerName: review.authorAttribution?.displayName?.trim() || "A Google user",
        reviewerPhoto: review.authorAttribution?.photoUri ?? "",
        rating: Math.min(Math.max(Math.round(Number(review.rating ?? 0)), 0), 5),
        comment: review.originalText?.text ?? review.text?.text ?? "",
        createTime: published,
        updateTime: published,
        reply: null,
        raw: review as Record<string, unknown>,
      };
    });

  return {
    reviews,
    averageRating: Number(data.rating ?? 0),
    totalReviewCount: Number(data.userRatingCount ?? 0),
  };
}
