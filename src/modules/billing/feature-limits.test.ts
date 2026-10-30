import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { COUNTED_FEATURES, featureUsage } from "./feature-limits.js";
import { getPlanCatalogEntry } from "./plans.catalog.js";
import { Dashboard } from "../dashboards/models/Dashboard.js";
import { Embed } from "../dashboards/models/Embed.js";
import { GoalTarget, TARGET_METRICS } from "../dashboards/models/GoalTarget.js";
import { Popup } from "../popups/models/Popup.js";
import { BioPage } from "../bio/models/BioPage.js";
import { Task } from "../tasks/models/Task.js";
import { fakeQuery } from "../../test-support/mongoose-fakes.js";

const WID = "66f1a2b3c4d5e6f708192a3b";

describe("COUNTED_FEATURES", () => {
  test("reads each limit from the plan", () => {
    const pro = getPlanCatalogEntry("pro")!;
    assert.equal(COUNTED_FEATURES.dashboards.limit(pro), pro.maxDashboards);
    assert.equal(COUNTED_FEATURES.embeds.limit(pro), pro.maxEmbeds);
    assert.equal(COUNTED_FEATURES.goalTargets.limit(pro), pro.maxGoalTargets);
    assert.equal(COUNTED_FEATURES.popups.limit(pro), pro.maxPopups);
    assert.equal(COUNTED_FEATURES.bioPages.limit(pro), pro.maxBioPages);
    assert.equal(COUNTED_FEATURES.tasks.limit(pro), pro.maxOpenTasks);
  });

  test("uses the kinds the upgrade dialog and da-forms expect", () => {
    assert.deepEqual(
      Object.values(COUNTED_FEATURES).map((f) => f.kind),
      ["dashboards", "embeds", "goal_targets", "popups", "bio_pages", "tasks"],
    );
  });
});

describe("featureUsage", () => {
  test("returns quota and usage for every counted feature in the workspace", async (t) => {
    const dashboards = t.mock.method(Dashboard, "countDocuments", () => fakeQuery(3));
    const embeds = t.mock.method(Embed, "countDocuments", () => fakeQuery(1));
    const goals = t.mock.method(GoalTarget, "countDocuments", () => fakeQuery(4));
    t.mock.method(Popup, "countDocuments", () => fakeQuery(0));
    t.mock.method(BioPage, "countDocuments", () => fakeQuery(2));
    t.mock.method(Task, "countDocuments", () => fakeQuery(7));
    const starter = getPlanCatalogEntry("starter")!;

    assert.deepEqual(await featureUsage(starter, WID), {
      dashboards: { quota: starter.maxDashboards, used: 3 },
      embeds: { quota: starter.maxEmbeds, used: 1 },
      goalTargets: { quota: starter.maxGoalTargets, used: 4 },
      popups: { quota: starter.maxPopups, used: 0 },
      bioPages: { quota: starter.maxBioPages, used: 2 },
      tasks: { quota: starter.maxOpenTasks, used: 7 },
    });
    assert.deepEqual(dashboards.mock.calls[0].arguments[0], { workspaceId: WID });
    assert.deepEqual(embeds.mock.calls[0].arguments[0], { workspaceId: WID });
    assert.deepEqual(goals.mock.calls[0].arguments[0], { workspaceId: WID, metric: { $in: TARGET_METRICS } });
  });
});
