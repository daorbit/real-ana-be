import { errorResponse, json, jsonBody, notFound, ref, unauthorized } from "../helpers.js";

const siteIdParam = {
  name: "siteId",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "The site's public tracking key, not its `_id`.",
};

export const platformPaths = {
  "/v1/me": {
    get: {
      tags: ["Authentication"],
      summary: "Check your API key",
      description:
        "Returns the workspace and key behind the token you sent. Call it first to confirm your key works, and to find the workspace ID the Orbit AI endpoints need.",
      responses: {
        200: json("The key and its workspace.", ref("Me")),
        401: unauthorized,
      },
    },
  },
  "/v1/projects": {
    post: {
      tags: ["Projects"],
      summary: "Create a project",
      description: "Projects group sites. A workspace can hold as many as its plan allows.",
      requestBody: jsonBody({
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", examples: ["Marketing site"] },
          extUserId: {
            type: "string",
            description: "Optional. Your own id for the owner of this project.",
          },
        },
      }),
      responses: {
        201: json("The project as stored.", ref("Project")),
        400: errorResponse("`name` was missing."),
        401: unauthorized,
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
        401: unauthorized,
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
      requestBody: jsonBody({
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
      }),
      responses: {
        201: json("The new site and its install snippet.", {
          type: "object",
          properties: { site: ref("Site"), snippet: { type: "string" } },
        }),
        400: errorResponse("`name` or `domain` was missing."),
        401: unauthorized,
        404: notFound,
      },
    },
    get: {
      tags: ["Sites"],
      summary: "List a project's sites",
      responses: {
        200: json("Sites under this project, newest first.", { type: "array", items: ref("Site") }),
        401: unauthorized,
        404: notFound,
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
        siteIdParam,
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
          description: "Narrow the result, `field:value`. Repeat the parameter to apply more than one.",
        },
      ],
      responses: {
        200: json("Figures for the window.", ref("Stats")),
        401: unauthorized,
        404: notFound,
      },
    },
  },
  "/v1/sites/{siteId}/snippet": {
    get: {
      tags: ["Sites"],
      summary: "Get a site's install snippet",
      parameters: [siteIdParam],
      responses: {
        200: json("The script tag to install.", {
          type: "object",
          properties: { snippet: { type: "string" } },
        }),
        401: unauthorized,
        404: notFound,
      },
    },
  },
  "/v1/sites/{siteId}": {
    delete: {
      tags: ["Sites"],
      summary: "Delete a site and its events",
      description:
        "Permanent. Every event recorded for this site is deleted with it, and the tracking key stops collecting immediately.",
      parameters: [siteIdParam],
      responses: {
        204: { description: "Deleted. No body." },
        401: unauthorized,
        404: notFound,
      },
    },
  },
  "/v1/markers": {
    post: {
      tags: ["Markers"],
      summary: "Record a deploy, release, or campaign",
      description: [
        "Draws a marker on the workspace's charts. Call it from CI on every deploy",
        "and the markers appear without anyone remembering to add them.",
        "",
        "```bash",
        "curl -X POST https://quantalog-be.daorbit.in/v1/markers \\",
        '  -H "Authorization: Bearer $QUANTALOG_API_KEY" \\',
        '  -H "Content-Type: application/json" \\',
        '  -d \'{"label":"v2.4.0","kind":"deploy","description":"\'"$GIT_SHA"\'"}\'',
        "```",
      ].join("\n"),
      requestBody: jsonBody({
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
      }),
      responses: {
        201: json("The marker as stored.", ref("Marker")),
        400: errorResponse("`label` was missing, too long, or `at` was not a valid date."),
        401: unauthorized,
        404: errorResponse("The key's workspace no longer exists."),
      },
    },
    get: {
      tags: ["Markers"],
      summary: "List recent markers",
      description: "The hundred most recent, newest first.",
      responses: {
        200: json("Markers in this workspace.", { type: "array", items: ref("Marker") }),
        401: unauthorized,
      },
    },
  },
  "/v1/reviews": {
    get: {
      tags: ["Reviews"],
      summary: "List your Google reviews",
      description: [
        "The reviews synced from the Google Business Profile connected to this",
        "workspace, built for displaying them on your own website.",
        "",
        "Served from Quantalog's cache rather than called through to Google, so",
        "it is safe to call on every page load. Reviews refresh on a schedule",
        "and whenever **Sync reviews** is pressed in the dashboard.",
        "",
        "`rating` and `totalReviews` are Google's own figures, not an average of",
        "the reviews in `reviews`.",
        "",
        "A workspace with no Google connection gets an empty list and a zero",
        "rating rather than an error.",
        "",
        "Google requires that review content it supplies is attributed to",
        "Google. The `attribution` object carries the wording to show.",
      ].join("\n"),
      parameters: [
        {
          name: "limit",
          in: "query",
          description: "Reviews per page, 1–100.",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        {
          name: "page",
          in: "query",
          description: "1-based page number.",
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "sort",
          in: "query",
          description: "Ordering. Anything unrecognised falls back to `newest`.",
          schema: { type: "string", enum: ["newest", "oldest", "highest", "lowest"], default: "newest" },
        },
        {
          name: "locationId",
          in: "query",
          description: "Restrict to one connected business. Omit to combine every location in the workspace.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: json("Reviews for this workspace.", ref("ReviewsResponse")),
        401: unauthorized,
      },
    },
  },
};
