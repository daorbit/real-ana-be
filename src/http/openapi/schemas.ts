import { ref } from "./helpers.js";

export const schemas = {
  Error: {
    type: "object",
    properties: { error: { type: "string", examples: ["site not found"] } },
    required: ["error"],
  },
  Me: {
    type: "object",
    properties: {
      workspace: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The workspace this key belongs to. Use it as `{wid}` in Orbit AI paths.",
            examples: ["66e0b1a8d3c2f1e0a9b8c7d6"],
          },
          name: { type: "string", examples: ["Acme Inc"] },
        },
      },
      key: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string", examples: ["Production backend"] },
          prefix: { type: "string", examples: ["sk_live_OH8u"] },
          createdAt: { type: "string", format: "date-time" },
          expiresAt: {
            type: ["string", "null"],
            format: "date-time",
            description: "Null when the key never expires.",
          },
        },
      },
    },
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
  TrackedUser: {
    type: "object",
    properties: {
      appUserId: { type: "string", examples: ["user_1042"] },
      lastSeen: { type: "string", format: "date-time" },
      lastAction: { type: "string", examples: ["checkout_started"] },
      siteId: { type: "string", examples: ["V1StGXR8Z5jdHi6B"] },
      eventCount: { type: "integer", examples: [37] },
    },
  },
  JourneyEvent: {
    type: "object",
    properties: {
      siteId: { type: "string" },
      action: { type: "string", examples: ["checkout_started"] },
      src: { type: "string", examples: ["cart"] },
      dest: { type: "string", examples: ["checkout"] },
      ts: { type: "string", format: "date-time" },
    },
  },
  Review: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Google's own review id. Stable, and safe to use as a key.",
        examples: ["AbFvOqm1..."],
      },
      author: { type: "string", examples: ["Rahul Sharma"] },
      photo: {
        type: "string",
        description:
          "The reviewer's Google avatar URL, or an empty string. Served from Google's own domain rather than copied.",
      },
      rating: { type: "integer", minimum: 1, maximum: 5, examples: [5] },
      comment: {
        type: "string",
        description: "Empty for a star-only rating, which is a normal kind of review.",
        examples: ["Excellent service!"],
      },
      reply: {
        type: "string",
        description: "The business owner's public reply. Absent when there is none.",
      },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  ReviewsResponse: {
    type: "object",
    properties: {
      rating: {
        type: "number",
        description: "Google's average across every connected location, weighted by review count.",
        examples: [4.8],
      },
      totalReviews: {
        type: "integer",
        description:
          "Google's own count. Larger than the number of reviews returned, because it includes ratings left without text.",
        examples: [127],
      },
      page: { type: "integer", examples: [1] },
      pageSize: { type: "integer", examples: [20] },
      reviews: { type: "array", items: ref("Review") },
      attribution: {
        type: "object",
        description:
          "Wording to display alongside the reviews. Google requires that content it supplies is attributed.",
        properties: {
          source: { type: "string", examples: ["Google"] },
          notice: { type: "string", examples: ["Reviews powered by Google"] },
        },
      },
    },
  },
  OrbitStatus: {
    type: "object",
    properties: {
      configured: { type: "boolean", description: "False when Orbit AI is switched off on this server." },
      plan: {
        type: "object",
        properties: {
          slug: { type: "string", examples: ["orbit-pro"] },
          name: { type: "string", examples: ["Orbit Pro"] },
          tier: { type: "string" },
          monthlyQuota: { type: "integer", examples: [500] },
          maxQuestionChars: { type: "integer", examples: [4000] },
          imageGeneration: { type: "boolean" },
        },
      },
      models: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Pass as `model` to `/ask`." },
            label: { type: "string" },
            hint: { type: "string" },
            locked: { type: "boolean", description: "True when the plan does not include this model." },
            tier: { type: "string" },
          },
        },
      },
    },
  },
  OrbitAnswer: {
    type: "object",
    properties: {
      reply: { type: "string", description: "The answer, in Markdown." },
      suggestions: { type: "array", items: { type: "string" }, description: "Follow-up questions to offer." },
      model: { type: "string", description: "The model that answered. May differ from the one requested." },
      modelLabel: { type: "string" },
      imageUrl: { type: "string", description: "Present when `generateImage` produced a picture." },
      dataDigest: { type: "object", description: "The workspace figures the answer was based on." },
      citations: { type: "array", items: { type: "object" } },
      conversationId: {
        type: ["string", "null"],
        description: "The thread this answer was saved to. Send it back to continue the conversation.",
      },
      remaining: { type: ["integer", "null"], description: "Questions left this month." },
    },
  },
  ConversationSummary: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string", examples: ["Why did traffic drop last week?"] },
      messageCount: { type: "integer", examples: [6] },
      lastMessageAt: { type: "string", format: "date-time" },
      lastModelLabel: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      userId: { type: ["string", "null"] },
    },
  },
};
