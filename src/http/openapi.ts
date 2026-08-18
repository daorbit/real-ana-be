/**
 * The OpenAPI description of the platform API.
 *
 * Hand-written rather than generated from decorators or JSDoc scanning: the
 * surface is one router (`/v1`), it changes rarely, and a spec kept beside the
 * routes it describes is easier to read — and to review in a diff — than the
 * annotations needed to produce the same document. The one rule is that this
 * file and `routes/v1.ts` are edited together.
 *
 * Served as interactive documentation at `/docs`, where a customer can paste a
 * key they just created and call their own workspace — which is the point:
 * a key that cannot be tried is a key nobody trusts.
 */

/** Where the API answers. Read at call time so a preview deploy documents itself. */
function servers() {
  const configured = process.env.PUBLIC_API_URL || process.env.PUBLIC_BASE_URL;
  const list: { url: string; description: string }[] = [];
  if (configured) {
    list.push({ url: configured, description: "This deployment" });
  }
  list.push(
    { url: "https://quantalog-be.daorbit.in", description: "Production" },
    { url: "http://localhost:4000", description: "Local development" },
  );
  // A configured origin that already matches one of the defaults would list twice.
  return list.filter((s, i) => list.findIndex((o) => o.url === s.url) === i);
}

/** `$ref` shorthand, so the paths below stay readable. */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** A JSON response body of one schema. */
const json = (description: string, schema: object) => ({
  description,
  content: { "application/json": { schema } },
});

/** The error shape every failure in this API uses. */
const errorResponse = (description: string) => json(description, ref("Error"));

export function buildOpenApiSpec() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Quantalog Platform API",
      version: "1.0.0",
      description: [
        "Server-to-server access to your Quantalog workspace: create projects and",
        "sites, read analytics, and annotate your charts with deploys and releases.",
        "",
        "## Authentication",
        "",
        "Every endpoint takes an API key as a bearer token:",
        "",
        "```",
        "Authorization: Bearer sk_live_xxxxxxxxxxxx",
        "```",
        "",
        "Create a key under **Developers** in the dashboard. The raw key is shown",
        "once, at creation — store it then, because only a hash is kept here and it",
        "cannot be shown again. A key authenticates one workspace, and reaches",
        "nothing outside it.",
        "",
        "To try a call on this page: press **Authorize**, paste your key, then",
        "**Try it out** on any endpoint. Requests go to the live API and act on",
        "real data in your own workspace.",
        "",
        "## Errors",
        "",
        "Failures return the HTTP status and a JSON body of `{ \"error\": \"…\" }`.",
        "A `401` means the key is missing, malformed, revoked, or unknown.",
      ].join("\n"),
      contact: { name: "Quantalog support", url: "https://quantalog.daorbit.in/contact" },
    },
    servers: servers(),
    tags: [
      { name: "Projects", description: "Group the sites you track." },
      { name: "Sites", description: "The properties sending events, and their stats." },
      {
        name: "Markers",
        description:
          "Deploys, releases, and campaigns drawn on the analytics timeline. Post one from CI and a traffic change a week later already has its cause on the chart.",
      },
    ],
    components: {
      securitySchemes: {
        ApiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "An API key from the dashboard's Developers page, sent as `Authorization: Bearer sk_live_…`.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "string", examples: ["site not found"] } },
          required: ["error"],
        },
        Project: {
          type: "object",
          properties: {
            _id: { type: "string", examples: ["6712f0a4c3b9d21e4a7f0011"] },
            workspaceId: { type: "string" },
            name: { type: "string", examples: ["Marketing site"] },
            extUserId: {
              type: "string",
              nullable: true,
              description:
                "Your own identifier for whoever owns this project. Set it when you resell Quantalog, so a project can be found by your user id rather than ours.",
            },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Site: {
          type: "object",
          properties: {
            _id: { type: "string" },
            siteId: {
              type: "string",
              description: "The public tracking key. It appears in the snippet and in every event.",
              examples: ["V1StGXR8Z5jdHi6B"],
            },
            workspaceId: { type: "string" },
            projectId: { type: "string" },
            name: { type: "string", examples: ["quantalog.com"] },
            domain: { type: "string", examples: ["quantalog.com"] },
            framework: {
              type: "string",
              description: "Only used to pick the right install instructions in the dashboard.",
              examples: ["next"],
            },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Stats: {
          type: "object",
          description:
            "Headline figures and breakdowns for the requested window. Lists are ordered by count, descending.",
          properties: {
            visitors: { type: "integer", examples: [199] },
            pageviews: { type: "integer", examples: [611] },
            live: { type: "integer", description: "Visitors active in the last five minutes.", examples: [1] },
            bounceRate: { type: "number", examples: [0.42] },
            avgSessionMs: { type: "integer", examples: [84000] },
            pagesPerSession: { type: "number", examples: [2.4] },
            topPages: { type: "array", items: ref("Breakdown") },
            topReferrers: { type: "array", items: ref("Breakdown") },
            countries: { type: "array", items: ref("Breakdown") },
            devices: { type: "array", items: ref("Breakdown") },
            browsers: { type: "array", items: ref("Breakdown") },
            operatingSystems: { type: "array", items: ref("Breakdown") },
            timeseries: {
              type: "array",
              description: "One bucket per interval across the window.",
              items: {
                type: "object",
                properties: {
                  t: { type: "string", format: "date-time" },
                  pageviews: { type: "integer" },
                  visitors: { type: "integer" },
                },
              },
            },
          },
        },
        Breakdown: {
          type: "object",
          properties: {
            name: { type: "string", examples: ["/pricing"] },
            count: { type: "integer", examples: [128] },
          },
        },
        Marker: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string", examples: ["v2.4.0"] },
            description: { type: "string", examples: ["9f2c1ab"] },
            kind: { type: "string", examples: ["deploy"] },
            at: { type: "string", format: "date-time" },
            siteIds: { type: "array", items: { type: "string" } },
          },
        },
      },
      responses: {
        Unauthorized: errorResponse("The key is missing, malformed, revoked, or unknown."),
        NotFound: errorResponse("No such resource in this key's workspace."),
      },
    },
    security: [{ ApiKey: [] }],
    paths: {
      "/v1/projects": {
        post: {
          tags: ["Projects"],
          summary: "Create a project",
          description: "Projects group sites. A workspace can hold as many as its plan allows.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string", examples: ["Marketing site"] },
                    extUserId: {
                      type: "string",
                      description: "Optional. Your own id for the owner of this project.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            201: json("The project as stored.", ref("Project")),
            400: errorResponse("`name` was missing."),
            401: { $ref: "#/components/responses/Unauthorized" },
          },
        },
        get: {
          tags: ["Projects"],
          summary: "List projects",
          description: "Newest first. Scoped to the key's workspace.",
          parameters: [
            {
              name: "extUserId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Return only projects carrying this external id.",
            },
          ],
          responses: {
            200: json("Every project in the workspace.", { type: "array", items: ref("Project") }),
            401: { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/v1/projects/{pid}/sites": {
        parameters: [
          {
            name: "pid",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "The project's `_id`, from `POST`/`GET /v1/projects`.",
          },
        ],
        post: {
          tags: ["Sites"],
          summary: "Add a site to a project",
          description:
            "Returns the site together with the script tag to install on it. The `siteId` in that snippet is what identifies incoming events.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "domain"],
                  properties: {
                    name: { type: "string", examples: ["Marketing site"] },
                    domain: { type: "string", examples: ["quantalog.com"] },
                    framework: {
                      type: "string",
                      description: "Optional. Picks the install instructions shown in the dashboard.",
                      examples: ["next"],
                    },
                  },
                },
              },
            },
          },
          responses: {
            201: json("The new site and its install snippet.", {
              type: "object",
              properties: { site: ref("Site"), snippet: { type: "string" } },
            }),
            400: errorResponse("`name` or `domain` was missing."),
            401: { $ref: "#/components/responses/Unauthorized" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
        get: {
          tags: ["Sites"],
          summary: "List a project's sites",
          responses: {
            200: json("Sites under this project, newest first.", { type: "array", items: ref("Site") }),
            401: { $ref: "#/components/responses/Unauthorized" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/v1/sites/{siteId}/stats": {
        get: {
          tags: ["Sites"],
          summary: "Read a site's analytics",
          description:
            "The same figures the dashboard draws, for one site. Filters use the dashboard's own syntax.",
          parameters: [
            {
              name: "siteId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The site's public tracking key, not its `_id`.",
            },
            {
              name: "range",
              in: "query",
              required: false,
              schema: { type: "string", default: "24h", examples: ["24h", "7d", "30d"] },
              description: "The window to report on. Defaults to the last 24 hours.",
            },
            {
              name: "filter",
              in: "query",
              required: false,
              schema: { type: "string", examples: ["country:IN"] },
              description:
                "Narrow the result, `field:value`. Repeat the parameter to apply more than one.",
            },
          ],
          responses: {
            200: json("Figures for the window.", ref("Stats")),
            401: { $ref: "#/components/responses/Unauthorized" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/v1/sites/{siteId}/snippet": {
        get: {
          tags: ["Sites"],
          summary: "Get a site's install snippet",
          parameters: [
            { name: "siteId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: json("The script tag to install.", {
              type: "object",
              properties: { snippet: { type: "string" } },
            }),
            401: { $ref: "#/components/responses/Unauthorized" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/v1/sites/{siteId}": {
        delete: {
          tags: ["Sites"],
          summary: "Delete a site and its events",
          description:
            "Permanent. Every event recorded for this site is deleted with it, and the tracking key stops collecting immediately.",
          parameters: [
            { name: "siteId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            204: { description: "Deleted. No body." },
            401: { $ref: "#/components/responses/Unauthorized" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/v1/markers": {
        post: {
          tags: ["Markers"],
          summary: "Record a deploy, release, or campaign",
          description: [
            "Draws a marker on the workspace's charts. The endpoint this feature",
            "exists for: called from CI on every deploy, the markers appear without",
            "anyone remembering to add them.",
            "",
            "```bash",
            "curl -X POST https://quantalog-be.daorbit.in/v1/markers \\",
            '  -H "Authorization: Bearer $QUANTALOG_KEY" \\',
            '  -H "Content-Type: application/json" \\',
            '  -d \'{"label":"v2.4.0","kind":"deploy","description":"\'"$GIT_SHA"\'"}\'',
            "```",
          ].join("\n"),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["label"],
                  properties: {
                    label: {
                      type: "string",
                      maxLength: 80,
                      examples: ["v2.4.0"],
                      description: "Shown on the chart. Keep it short.",
                    },
                    description: {
                      type: "string",
                      maxLength: 500,
                      description: "Longer detail, revealed on hover. A commit SHA fits well here.",
                    },
                    kind: {
                      type: "string",
                      default: "deploy",
                      description: "Decides the marker's colour and icon. An unknown value falls back to `deploy`.",
                      examples: ["deploy"],
                    },
                    at: {
                      type: "string",
                      format: "date-time",
                      description: "When it happened. Defaults to now — pass this only to backfill.",
                    },
                    siteIds: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "Limit the marker to these sites. Ids outside this workspace are dropped. Omit to mark every chart in the workspace.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            201: json("The marker as stored.", ref("Marker")),
            400: errorResponse("`label` was missing, too long, or `at` was not a valid date."),
            401: { $ref: "#/components/responses/Unauthorized" },
            404: errorResponse("The key's workspace no longer exists."),
          },
        },
        get: {
          tags: ["Markers"],
          summary: "List recent markers",
          description: "The hundred most recent, newest first.",
          responses: {
            200: json("Markers in this workspace.", { type: "array", items: ref("Marker") }),
            401: { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
    },
  };
}
