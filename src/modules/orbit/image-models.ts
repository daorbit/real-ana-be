export type OrbitImageModel = {
  id: string;
  label: string;
  hint: string;
  model: string;
  steps: number;
  multipart: boolean;
  nativeAspect: boolean;
};

export const ORBIT_IMAGE_MODELS: OrbitImageModel[] = [
  {
    id: "flux-schnell",
    label: "FLUX.1 Schnell",
    hint: "Fast. Square output, cropped to shape.",
    model: "@cf/black-forest-labs/flux-1-schnell",
    steps: 4,
    multipart: false,
    nativeAspect: false,
  },
  {
    id: "flux-2-klein",
    label: "FLUX.2 Klein 4B",
    hint: "Newer model, drawn at the requested shape. Super admin only.",
    model: "@cf/black-forest-labs/flux-2-klein-4b",
    steps: 4,
    multipart: true,
    nativeAspect: true,
  },
];

export function availableImageModels(exclude: string[] = []): OrbitImageModel[] {
  return ORBIT_IMAGE_MODELS.filter((m) => !exclude.includes(m.id));
}

export function resolveImageModel(id?: string, exclude: string[] = []): OrbitImageModel {
  const available = availableImageModels(exclude);
  return available.find((m) => m.id === id) ?? available[0] ?? ORBIT_IMAGE_MODELS[0];
}
