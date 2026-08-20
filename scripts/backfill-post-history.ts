import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { ScheduledPost } from "../src/modules/social/models/ScheduledPost.js";
import { SocialPostRun } from "../src/modules/social/models/SocialPostRun.js";

/**
 * One-off: seed published-post history from what the schedules still remember.
 *
 * `SocialPostRun` records one row per publish, but it did not exist until now,
 * so the Sent tab starts empty even for accounts that have been posting for
 * months. Each `ScheduledPost` kept the URL of its most recent successful
 * publish in `lastPostUrl`, and that is enough to reconstruct one row apiece.
 *
 * ## What this cannot recover
 *
 * Only the last publish per schedule. A weekly post that has gone out twenty
 * times overwrote `lastPostUrl` nineteen times; those publishes left no trace
 * anywhere in this database and are gone for good. `postCount` still says how
 * many there were, which is why the Sent tab's totals may exceed its rows for a
 * while.
 *
 * Posts made directly on LinkedIn are likewise absent — they were never ours to
 * record, and reading them back needs a permission this application does not
 * have.
 *
 * ## Why the URN is recovered by regex
 *
 * The statistics API keys on `urn:li:share:<id>`, never on a URL, and the URN
 * was discarded at publish time. It is recoverable here only because the
 * permalink was built from it — `permalink()` in `linkedin-post` embeds the URN
 * verbatim — so parsing it back out is reversing a known construction rather
 * than guessing. Rows whose URL does not match that shape are still written,
 * with an empty URN: the post is real history worth showing even if its
 * engagement can never be fetched.
 *
 * Safe to re-run. Rows are matched on their URN, and a schedule whose last
 * publish is already recorded is skipped rather than duplicated.
 *
 *   npx tsx scripts/backfill-post-history.ts          # report only
 *   npx tsx scripts/backfill-post-history.ts --write  # apply
 */

const WRITE = process.argv.includes("--write");

/** Pull the URN back out of a permalink built by `permalink()`. */
function urnFromUrl(url: string): string {
  const match = /\/feed\/update\/(urn:li:(?:share|ugcPost):\d+)/.exec(url);
  return match ? match[1] : "";
}

async function main() {
  await connectDB();

  // Only schedules that actually published something. A row that has never run,
  // or whose last run failed, has no history to recover.
  const posts = await ScheduledPost.find({ lastPostUrl: { $nin: ["", null] } }).sort({
    lastRunAt: 1,
  });

  console.log(`${posts.length} schedule(s) with a recorded publish.\n`);

  let created = 0;
  let skipped = 0;
  let withoutUrn = 0;

  for (const post of posts) {
    const url = String(post.lastPostUrl ?? "");
    const postUrn = urnFromUrl(url);

    // `lastRunAt` is when it published. Falling back to the row's creation time
    // keeps a schedule with a URL but no stamp from being dropped entirely —
    // the ordering will be slightly wrong, which beats losing the post.
    const publishedAt = post.lastRunAt ?? (post.get("createdAt") as Date) ?? new Date();

    // Matched on the URN where there is one. Without it there is no key that
    // distinguishes two publishes of the same schedule, so the schedule id and
    // timestamp stand in.
    const existing = await SocialPostRun.findOne(
      postUrn
        ? { postUrn }
        : { scheduledPostId: post._id, publishedAt },
    );

    if (existing) {
      skipped++;
      continue;
    }

    if (!postUrn) withoutUrn++;

    if (WRITE) {
      await SocialPostRun.create({
        userId: post.userId,
        workspaceId: post.workspaceId,
        scheduledPostId: post._id,
        source: "schedule",
        status: "published",
        postUrn,
        postUrl: url,
        // The schedule's *current* caption, which may have been edited since it
        // published. Unavoidable: the original text was never stored. Rows
        // written from here on carry what actually went out.
        caption: post.caption,
        imageUrl: post.imageUrl,
        name: post.name,
        publishedAt,
      });
    }

    created++;
  }

  console.log(
    `${WRITE ? "Created" : "Would create"} ${created} history row(s); `
    + `${skipped} already recorded.`,
  );
  if (withoutUrn) {
    console.log(
      `${withoutUrn} row(s) have no recoverable post URN and can never carry statistics.`,
    );
  }

  const lost = posts.reduce((sum, p) => sum + Math.max((p.postCount ?? 1) - 1, 0), 0);
  if (lost) {
    console.log(
      `\nNote: ${lost} earlier publish(es) were overwritten before this history existed `
      + `and cannot be recovered.`,
    );
  }

  if (!WRITE) console.log("\nDry run. Re-run with --write to apply.");

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
