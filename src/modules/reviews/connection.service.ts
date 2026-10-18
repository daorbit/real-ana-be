import { GoogleConnection } from "./models/GoogleConnection.js";
import { GoogleLocation } from "./models/GoogleLocation.js";
import { GoogleReview } from "./models/GoogleReview.js";
export async function disconnectGoogleReviews(workspaceId: string): Promise<void> {
  const businessLocations = await GoogleLocation.find({ workspaceId, source: { $ne: "places" } })
    .select("_id")
    .lean();

  const locationIds = businessLocations.map((location) => location._id);
  await Promise.all([
    GoogleReview.deleteMany({ workspaceId, googleLocationId: { $in: locationIds } }),
    GoogleLocation.deleteMany({ workspaceId, _id: { $in: locationIds } }),
    GoogleConnection.deleteOne({ workspaceId }),
  ]);
}

export async function removeReviewLocation(workspaceId: string, locationId: string): Promise<boolean> {
  const location = await GoogleLocation.findOneAndDelete({ _id: locationId, workspaceId });
  if (!location) return false;
  await GoogleReview.deleteMany({ workspaceId, googleLocationId: location._id });
  return true;
}
