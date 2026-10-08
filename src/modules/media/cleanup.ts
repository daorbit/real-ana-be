import { Media } from "./models/Media.js";
import { deleteAssets, type ResourceKind } from "../../infra/storage/cloudinary.js";

type StoredFile = { publicId: string; kind: ResourceKind; pipeline?: ResourceKind };

export async function deleteWorkspaceMedia(workspaceIds: string[]): Promise<void> {
  const files = (await Media.find({ workspaceId: { $in: workspaceIds } })
    .select("publicId kind pipeline")
    .lean()) as StoredFile[];

  const byPipeline: Record<ResourceKind, string[]> = { image: [], video: [], raw: [] };
  for (const file of files) byPipeline[file.pipeline ?? file.kind]?.push(file.publicId);

  await Promise.all(
    (Object.keys(byPipeline) as ResourceKind[])
      .filter((kind) => byPipeline[kind].length)
      .map((kind) => deleteAssets(byPipeline[kind], kind)),
  );

  await Media.deleteMany({ workspaceId: { $in: workspaceIds } });
}
