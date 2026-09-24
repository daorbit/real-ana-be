import { errorResponse, json, jsonBody, notFound, ref, unauthorized } from "../helpers.js";

const widParam = {
  name: "wid",
  in: "path",
  required: true,
  schema: { type: "string" },
  description:
    "Your workspace ID. Copy it from the Developers page, or read `workspace.id` from `GET /v1/me`. It must be the workspace your API key belongs to.",
  examples: { workspace: { value: "66e0b1a8d3c2f1e0a9b8c7d6" } },
};

const conversationIdParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "The conversation's `id`, from the list or from an `/ask` answer.",
};

const base = "/api/workspaces/{wid}/orbit";

export const orbitPaths = {
  [`${base}/status`]: {
    parameters: [widParam],
    get: {
      tags: ["Orbit AI"],
      summary: "Get Orbit AI plan and models",
      description: "What this workspace's plan allows, and the models you can pass as `model` to `/ask`.",
      responses: {
        200: json("Plan and available models.", ref("OrbitStatus")),
        401: unauthorized,
        404: errorResponse("`wid` is not the workspace this key belongs to."),
      },
    },
  },
  [`${base}/ask`]: {
    parameters: [widParam],
    post: {
      tags: ["Orbit AI"],
      summary: "Ask Orbit AI a question",
      description:
        "Answers questions about this workspace's analytics. Each call uses one question from the monthly allowance. Send `conversationId` from a previous answer to continue that thread.",
      requestBody: jsonBody({
        type: "object",
        properties: {
          question: {
            type: "string",
            examples: ["Which pages brought the most visitors last week?"],
            description: "Required unless you attach an image or document.",
          },
          model: { type: "string", description: "A model `id` from `/status`. Unknown ids use the default." },
          conversationId: { type: "string", description: "Continue an existing thread." },
          history: {
            type: "array",
            description: "Earlier turns to give the model context, oldest first.",
            items: {
              type: "object",
              properties: {
                role: { type: "string", enum: ["user", "assistant"] },
                content: { type: "string" },
              },
            },
          },
          image: { type: "string", description: "An image to ask about, as a base64 data URL." },
          document: {
            type: "object",
            description: "A PDF, DOCX, CSV or text file to ask about. Read and discarded, not stored.",
            properties: {
              name: { type: "string" },
              mime: { type: "string", examples: ["application/pdf"] },
              data: { type: "string", description: "Base64, optionally as a data URL." },
            },
          },
          generateImage: { type: "boolean", description: "Draw a picture from `question`. Orbit Pro only." },
        },
      }),
      responses: {
        200: json("The answer.", ref("OrbitAnswer")),
        400: errorResponse("No question, or an unsupported attachment."),
        401: unauthorized,
        402: errorResponse("The monthly allowance is used up, or the plan does not include this feature."),
        404: errorResponse("`wid` is not the workspace this key belongs to."),
        429: errorResponse("Too many questions this hour."),
        503: errorResponse("Orbit AI is not available on this server."),
      },
    },
  },
  [`${base}/explain`]: {
    parameters: [widParam],
    post: {
      tags: ["Orbit AI"],
      summary: "Explain why a metric changed",
      description: "A short explanation of one metric's movement for one site. Uses one question from the allowance.",
      requestBody: jsonBody({
        type: "object",
        required: ["siteId", "metric"],
        properties: {
          siteId: { type: "string", examples: ["V1StGXR8Z5jdHi6B"] },
          metric: {
            type: "string",
            enum: ["visitors", "pageviews", "sessions", "bounceRate", "avgSessionMs", "avgTimeOnPageMs", "pagesPerSession"],
          },
          range: { type: "string", default: "7d", examples: ["7d", "30d"] },
          from: { type: "string", format: "date-time" },
          to: { type: "string", format: "date-time" },
          compare: { type: "string" },
          compareFrom: { type: "string", format: "date-time" },
          compareTo: { type: "string", format: "date-time" },
        },
      }),
      responses: {
        200: json("The explanation.", { type: "object", properties: { reply: { type: "string" } } }),
        400: errorResponse("Missing site or unknown metric."),
        401: unauthorized,
        402: errorResponse("The plan does not include data access, or the allowance is used up."),
        404: notFound,
        429: errorResponse("Too many explanations this hour."),
      },
    },
  },
  [`${base}/conversations`]: {
    parameters: [widParam],
    get: {
      tags: ["Orbit AI"],
      summary: "List conversations",
      description: "Most recent first. Pass `nextCursor` back as `cursor` for the next page.",
      parameters: [
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1 } },
        { name: "cursor", in: "query", schema: { type: "string" } },
      ],
      responses: {
        200: json("A page of conversations.", {
          type: "object",
          properties: {
            conversations: { type: "array", items: ref("ConversationSummary") },
            nextCursor: { type: ["string", "null"] },
          },
        }),
        401: unauthorized,
      },
    },
  },
  [`${base}/conversations/{id}`]: {
    parameters: [widParam, conversationIdParam],
    get: {
      tags: ["Orbit AI"],
      summary: "Read a conversation",
      description: "The conversation with its most recent turns. Pass `before` to page further back.",
      parameters: [
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1 } },
        { name: "before", in: "query", schema: { type: "integer" }, description: "A turn `seq` to read before." },
      ],
      responses: {
        200: json("The conversation.", { type: "object" }),
        401: unauthorized,
        404: notFound,
      },
    },
    patch: {
      tags: ["Orbit AI"],
      summary: "Rename a conversation",
      requestBody: jsonBody({
        type: "object",
        required: ["title"],
        properties: { title: { type: "string", examples: ["Traffic drop in March"] } },
      }),
      responses: {
        200: json("Renamed.", { type: "object", properties: { ok: { type: "boolean" } } }),
        400: errorResponse("`title` was empty."),
        401: unauthorized,
        404: notFound,
      },
    },
    delete: {
      tags: ["Orbit AI"],
      summary: "Delete a conversation",
      responses: {
        200: json("Deleted.", { type: "object", properties: { ok: { type: "boolean" } } }),
        401: unauthorized,
        404: notFound,
      },
    },
  },
  [`${base}/conversations/bulk-delete`]: {
    parameters: [widParam],
    post: {
      tags: ["Orbit AI"],
      summary: "Delete several conversations",
      requestBody: jsonBody({
        type: "object",
        required: ["ids"],
        properties: { ids: { type: "array", maxItems: 100, items: { type: "string" } } },
      }),
      responses: {
        200: json("Deleted.", {
          type: "object",
          properties: { ok: { type: "boolean" }, deleted: { type: "integer" } },
        }),
        400: errorResponse("`ids` was empty."),
        401: unauthorized,
      },
    },
  },
};
