import { errorResponse, servers } from "./openapi/helpers.js";
import { schemas } from "./openapi/schemas.js";
import { platformPaths } from "./openapi/paths/platform.js";
import { trackingPaths } from "./openapi/paths/tracking.js";
import { orbitPaths } from "./openapi/paths/orbit.js";

const description = [
  "Server-to-server access to your Quantalog workspace: create projects and",
  "sites, read analytics, trace your users' journeys, and ask Orbit AI about",
  "your data.",
  "",
  "## Try it here",
  "",
  "1. Create a key on the **Developers** page of the dashboard.",
  "2. Press **Authorize** above and paste the key (starting with `sk_live_`).",
  "3. Open **Authentication → GET /v1/me** and press **Try it out**, then",
  "   **Execute**. You'll see your workspace ID and key details.",
  "4. For **Orbit AI** endpoints, paste that workspace ID into the `wid` field.",
  "",
  "Requests go to the live API and act on real data in your workspace.",
  "",
  "## Authentication",
  "",
  "Every endpoint takes an API key as a bearer token:",
  "",
  "```",
  "Authorization: Bearer sk_live_xxxxxxxxxxxx",
  "```",
  "",
  "The raw key is shown once, when it's created. Only a hash is stored, so it",
  "cannot be shown again. A key only works in the workspace it was created in.",
  "",
  "## Errors",
  "",
  "Failures return the HTTP status and a JSON body of `{ \"error\": \"…\" }`.",
  "A `401` means the key is missing, malformed, revoked, expired, or unknown.",
].join("\n");

export function buildOpenApiSpec() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Quantalog Platform API",
      version: "1.1.0",
      description,
      contact: { name: "Quantalog support", url: "https://quantalog.daorbit.in/contact" },
    },
    servers: servers(),
    tags: [
      { name: "Authentication", description: "Check a key and find its workspace ID." },
      { name: "Projects", description: "Group the sites you track." },
      { name: "Sites", description: "The properties sending events, and their stats." },
      {
        name: "User journeys",
        description: "Trace what signed-in users do in your web or mobile app, one step at a time.",
      },
      {
        name: "Markers",
        description: "Deploys, releases, and campaigns drawn on the analytics timeline.",
      },
      {
        name: "Reviews",
        description: "Your Google Business Profile reviews, ready to display on your own site.",
      },
      {
        name: "Orbit AI",
        description: "Ask questions about your analytics. These paths need your workspace ID as `wid`.",
      },
    ],
    components: {
      securitySchemes: {
        ApiKey: {
          type: "http",
          scheme: "bearer",
          description: "An API key from the dashboard's Developers page, sent as `Authorization: Bearer sk_live_…`.",
        },
      },
      schemas,
      responses: {
        Unauthorized: errorResponse("The key is missing, malformed, revoked, expired, or unknown."),
        NotFound: errorResponse("No such resource in this key's workspace."),
      },
    },
    security: [{ ApiKey: [] }],
    paths: {
      ...platformPaths,
      ...trackingPaths,
      ...orbitPaths,
    },
  };
}
