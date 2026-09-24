export function servers() {
  const configured = process.env.PUBLIC_API_URL || process.env.PUBLIC_BASE_URL;
  const list: { url: string; description: string }[] = [];
  if (configured) {
    list.push({ url: configured, description: "This deployment" });
  }
  list.push(
    { url: "https://quantalog-be.daorbit.in", description: "Production" },
    { url: "http://localhost:4000", description: "Local development" },
  );

  return list.filter((s, i) => list.findIndex((o) => o.url === s.url) === i);
}

export const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export const json = (description: string, schema: object) => ({
  description,
  content: { "application/json": { schema } },
});

export const errorResponse = (description: string) => json(description, ref("Error"));

export const unauthorized = { $ref: "#/components/responses/Unauthorized" };
export const notFound = { $ref: "#/components/responses/NotFound" };

export const jsonBody = (schema: object) => ({
  required: true,
  content: { "application/json": { schema } },
});
