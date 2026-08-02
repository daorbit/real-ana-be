import mongoose, { Schema } from "mongoose";

/**
 * One message sent through the contact form on the marketing site.
 *
 * The form is unauthenticated — the whole point is that someone who has not
 * signed up can reach us — so everything here is attacker-controlled text and
 * is length-capped at the schema rather than trusted. Nothing in this document
 * is ever rendered as HTML.
 *
 * `ipHash` is an HMAC of the sender's address keyed by the server secret, the
 * same construction the demo throttle uses: enough to rate-limit one caller and
 * to recognise a flood after the fact, without the row identifying anyone or
 * the value being reversible by someone holding only the database.
 *
 * Unlike the demo rows these do not expire. A message is correspondence, and
 * quietly deleting one after a day would lose a customer's question.
 */
const contactMessageSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    /** Optional: only some enquiries are about a company. */
    company: { type: String, trim: true, maxlength: 160, default: "" },
    subject: {
      type: String,
      required: true,
      enum: [
        "general",
        "sales",
        "support",
        "platform-api",
        "privacy",
        "other",
        // Raised from inside the dashboard rather than the marketing site.
        "bug",
        "feedback",
      ],
      default: "general",
    },
    message: { type: String, required: true, trim: true, maxlength: 5000 },

    /** Where the sender was when they submitted, for context on the reply. */
    pageUrl: { type: String, trim: true, maxlength: 500, default: "" },

    /**
     * Which surface this came from. A bug report from a signed-in customer and
     * a sales enquiry from a stranger deserve different urgency, and the two
     * are indistinguishable once they are both just rows.
     */
    source: {
      type: String,
      enum: ["marketing", "app"],
      default: "marketing",
      index: true,
    },
    /**
     * The account that sent it, when there was one. Set from the authenticated
     * session on the server — never from the request body, which the client
     * could claim anything in.
     */
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },

    status: {
      type: String,
      enum: ["new", "read", "replied", "spam"],
      default: "new",
      index: true,
    },
    /** Free-text note an admin adds after handling it. Never shown to the sender. */
    adminNote: { type: String, trim: true, maxlength: 2000, default: "" },

    /**
     * Replies sent from the dashboard, oldest first.
     *
     * Kept on the message rather than in a separate collection because a reply
     * has no meaning apart from the thing it answers, and the whole exchange is
     * always read together. Storing what was actually sent also means the next
     * admin can see the reply rather than guessing from a "replied" badge.
     */
    replies: {
      type: [
        {
          _id: false,
          subject: { type: String, required: true, maxlength: 200 },
          body: { type: String, required: true, maxlength: 10000 },
          /** Email of the admin who sent it, for accountability. */
          sentBy: { type: String, required: true, maxlength: 200 },
          sentAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    ipHash: { type: String, required: true },
    /** Trimmed hard: a user agent is unbounded and we only want the rough client. */
    userAgent: { type: String, maxlength: 300, default: "" },

    createdAt: { type: Date, default: Date.now },
    readAt: { type: Date, default: null },
    /**
     * When the automatic "we got your message" receipt went out. Null means it
     * never did — mail was unconfigured or the send failed — which is worth
     * seeing in the inbox, because the sender is still waiting on silence.
     */
    ackSentAt: { type: Date, default: null },
  },
  { versionKey: false }
);

// The admin list is "newest first, optionally filtered by status".
contactMessageSchema.index({ status: 1, createdAt: -1 });
contactMessageSchema.index({ createdAt: -1 });
// Counting one sender's recent messages is the read on the submit path.
contactMessageSchema.index({ ipHash: 1, createdAt: 1 });

export const ContactMessage = mongoose.model("ContactMessage", contactMessageSchema);
