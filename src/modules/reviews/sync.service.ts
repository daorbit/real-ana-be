import { GoogleConnection } from "./models/GoogleConnection.js";
import { GoogleLocation } from "./models/GoogleLocation.js";
import { GoogleReview } from "./models/GoogleReview.js";
import {
  GoogleApiError,
  listReviews,
  refreshAccessToken,
} from "../../infra/http-client/google-business.js";
import { decryptSecret, encryptSecret } from "../../shared/utils/crypto-box.js";

 
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** A cron run touches a bounded number of locations so one invocation can finish. */
const CRON_BATCH = 25;

export type SyncResult = {
  locationId: string;
  added: number;
  updated: number;
  removed: number;
  total: number;
  averageRating: number;
};

 
export async function usableAccessToken(connectionId: string): Promise<string> {
  const connection = await GoogleConnection.findById(connectionId).select(
    "+accessToken +refreshToken",
  );
  if (!connection) throw new GoogleApiError("not_found", 404, "connection not found");

  const expiresAt = connection.get("expiresAt") as Date | undefined;
  const stillValid = expiresAt instanceof Date && expiresAt.getTime() > Date.now();

  if (stillValid) {
    const token = decryptSecret(String(connection.get("accessToken") ?? ""));
    // A token that will not decrypt is unrecoverable in the same way a revoked
    // one is: the encryption key changed, and no retry will bring it back.
    if (token) return token;
  }

  const storedRefresh = decryptSecret(String(connection.get("refreshToken") ?? ""));
  if (!storedRefresh) {
    await markConnectionRevoked(
      connectionId,
      "Google did not provide a refresh token. Reconnect Google to continue syncing.",
    );
    throw new GoogleApiError("revoked", 401, "no refresh token stored");
  }

  try {
    const tokens = await refreshAccessToken(storedRefresh);
    await GoogleConnection.updateOne(
      { _id: connectionId },
      {
        accessToken: encryptSecret(tokens.accessToken),
        expiresAt: tokens.expiresAt,
        // Google usually omits a new refresh token on a refresh; keeping the
        // existing one is correct, and overwriting with an empty string here
        // would destroy the connection on the next run.
        ...(tokens.refreshToken ? { refreshToken: encryptSecret(tokens.refreshToken) } : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
        status: "active",
        statusMessage: "",
      },
    );
    return tokens.accessToken;
  } catch (err) {
    if (err instanceof GoogleApiError && err.kind === "revoked") {
      await markConnectionRevoked(
        connectionId,
        "Google access was revoked. Reconnect Google to continue syncing.",
      );
    }
    throw err;
  }
}

async function markConnectionRevoked(connectionId: string, message: string): Promise<void> {
  await GoogleConnection.updateOne(
    { _id: connectionId },
    { status: "revoked", statusMessage: message },
  );
  // Locations follow the connection: a location whose token is dead is not
  // "connected" in any sense the dashboard should imply.
  await GoogleLocation.updateMany(
    { googleConnectionId: connectionId, status: "connected" },
    { status: "error", lastSyncError: message },
  );
}

 
export function explainGoogleError(err: unknown): string {
  if (!(err instanceof GoogleApiError)) return "Reviews could not be synced. Please try again.";

  switch (err.kind) {
    case "revoked":
      return "Google access was revoked. Reconnect Google to continue syncing reviews.";
    case "quota":
      return "Google's review API limit was reached. The next scheduled sync will retry automatically.";
    case "not_enabled":
      return "Google has not yet granted this deployment access to the Business Profile API.";
    case "forbidden":
      return "This Google account no longer has access to that business location.";
    case "not_found":
      return "That business location is no longer available on Google.";
    case "unavailable":
      return "Google is temporarily unavailable. The next scheduled sync will retry automatically.";
    default:
      return "Reviews could not be synced. Please try again.";
  }
}

 
export async function syncLocation(locationRowId: string): Promise<SyncResult> {
  const location = await GoogleLocation.findById(locationRowId);
  if (!location) throw new GoogleApiError("not_found", 404, "location not found");

  const connectionId = String(location.get("googleConnectionId"));
  const workspaceId = location.get("workspaceId");

  try {
    const accessToken = await usableAccessToken(connectionId);
    const page = await listReviews(
      accessToken,
      String(location.get("googleAccountId")),
      String(location.get("googleLocationId")),
    );

    let added = 0;
    let updated = 0;

    // Upserts one at a time rather than a bulk write: the collections are small
    // per location, and a per-review result is what makes `added`/`updated`
    // reportable to the user who pressed Sync.
    for (const review of page.reviews) {
      const result = await GoogleReview.updateOne(
        { workspaceId, googleReviewId: review.reviewId },
        {
          $set: {
            googleLocationId: location._id,
            reviewerName: review.reviewerName,
            reviewerPhoto: review.reviewerPhoto,
            rating: review.rating,
            comment: review.comment,
            reviewCreatedAt: review.createTime,
            reviewUpdatedAt: review.updateTime,
            replyComment: review.reply?.comment ?? "",
            replyUpdatedAt: review.reply?.updateTime ?? null,
            raw: review.raw,
            // A review that reappears was not deleted after all.
            deletedAt: null,
          },
          $setOnInsert: { workspaceId },
        },
        { upsert: true },
      );

      if (result.upsertedCount) added += 1;
      else if (result.modifiedCount) updated += 1;
    }

    // Only safe when the whole list was read — see the note above.
    const completeRead = page.reviews.length >= page.totalReviewCount;
    let removed = 0;
    if (completeRead) {
      const seen = page.reviews.map((r) => r.reviewId);
      const gone = await GoogleReview.updateMany(
        {
          workspaceId,
          googleLocationId: location._id,
          googleReviewId: { $nin: seen },
          deletedAt: null,
        },
        { deletedAt: new Date() },
      );
      removed = gone.modifiedCount ?? 0;
    }

    await GoogleLocation.updateOne(
      { _id: location._id },
      {
        averageRating: page.averageRating,
        totalReviewCount: page.totalReviewCount,
        lastSyncedAt: new Date(),
        lastSyncError: "",
        status: "connected",
      },
    );

    return {
      locationId: String(location._id),
      added,
      updated,
      removed,
      total: page.totalReviewCount,
      averageRating: page.averageRating,
    };
  } catch (err) {
    const message = explainGoogleError(err);
    // A quota or outage failure is transient: the location stays `connected`
    // so the dashboard keeps showing cached reviews instead of implying the
    // business was disconnected. Only a permanent failure changes the status.
    const transient =
      err instanceof GoogleApiError && (err.kind === "quota" || err.kind === "unavailable");

    await GoogleLocation.updateOne(
      { _id: location._id },
      { lastSyncError: message, ...(transient ? {} : { status: "error" }) },
    );
    throw err;
  }
}

/**
 * Refresh every location that has gone stale.
 *
 * Each location is attempted independently: one workspace with a revoked token
 * must not stop the rest of the sweep, so failures are counted and logged
 * rather than thrown. The caller is a cron endpoint whose only meaningful
 * response is a tally.
 */
export async function syncDue(): Promise<{ ran: number; failed: number }> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);

  const due = await GoogleLocation.find({
    status: "connected",
    $or: [{ lastSyncedAt: { $lt: cutoff } }, { lastSyncedAt: null }],
  })
    .sort({ lastSyncedAt: 1 })
    .limit(CRON_BATCH)
    .select("_id");

  let ran = 0;
  let failed = 0;

  for (const location of due) {
    try {
      await syncLocation(String(location._id));
      ran += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[reviews-sync] location ${location._id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { ran, failed };
}
