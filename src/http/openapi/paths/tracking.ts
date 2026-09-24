import { errorResponse, json, jsonBody, ref, unauthorized } from "../helpers.js";

const appUserIdParam = {
  name: "appUserId",
  in: "path",
  required: true,
  schema: { type: "string", maxLength: 120 },
  description: "Your own id for the signed-in user, as your app knows them.",
  examples: { user: { value: "user_1042" } },
};

export const trackingPaths = {
  "/v1/track/{appUserId}": {
    parameters: [appUserIdParam],
    post: {
      tags: ["User journeys"],
      summary: "Record a step in a user's journey",
      description:
        "One call per action a signed-in user takes in your web or mobile app. There is no separate identify step: the `appUserId` in the path is the identity.",
      requestBody: jsonBody({
        type: "object",
        required: ["siteId", "action"],
        properties: {
          siteId: {
            type: "string",
            description: "The site's public tracking key. It must belong to this key's workspace.",
            examples: ["V1StGXR8Z5jdHi6B"],
          },
          action: { type: "string", maxLength: 80, examples: ["checkout_started"] },
          src: { type: "string", maxLength: 120, description: "Where the user was.", examples: ["cart"] },
          dest: { type: "string", maxLength: 120, description: "Where they went.", examples: ["checkout"] },
        },
      }),
      responses: {
        201: json("Recorded.", { type: "object", properties: { ok: { type: "boolean", examples: [true] } } }),
        400: errorResponse("`siteId` or `action` was missing."),
        401: unauthorized,
        404: errorResponse("That site is not in this key's workspace."),
      },
    },
    get: {
      tags: ["User journeys"],
      summary: "Read one user's journey",
      description: "Every recorded step for this user, oldest first.",
      parameters: [
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 1000, default: 500 },
        },
      ],
      responses: {
        200: json("The user's steps.", {
          type: "object",
          properties: {
            appUserId: { type: "string" },
            events: { type: "array", items: ref("JourneyEvent") },
          },
        }),
        401: unauthorized,
      },
    },
  },
  "/v1/users": {
    get: {
      tags: ["User journeys"],
      summary: "List tracked users",
      description: "Every `appUserId` that has recorded at least one step, most recently active first. Up to 100.",
      parameters: [
        {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Match user ids containing this text.",
        },
      ],
      responses: {
        200: json("Tracked users.", {
          type: "object",
          properties: { users: { type: "array", items: ref("TrackedUser") } },
        }),
        401: unauthorized,
      },
    },
  },
};
