import { GoogleLocation } from "./models/GoogleLocation.js";
import { explainLocationError, syncLocation, type SyncResult } from "./sync.service.js";

export type PlaceLocationInput = {
  placeId: string;
  title: string;
  address: string;
};

export async function connectPlaceLocation(workspaceId: string, input: PlaceLocationInput) {
  const location = await GoogleLocation.findOneAndUpdate(
    { workspaceId, googleLocationId: input.placeId },
    {
      workspaceId,
      source: "places",
      googleLocationId: input.placeId,
      title: input.title,
      address: input.address,
      status: "connected",
      lastSyncError: "",
    },
    { upsert: true, new: true },
  );

  let sync: SyncResult | null = null;
  let syncError: string | undefined;
  try {
    sync = await syncLocation(String(location._id));
  } catch (err) {
    syncError = explainLocationError(err, "places");
  }

  return { location, sync, syncError };
}
