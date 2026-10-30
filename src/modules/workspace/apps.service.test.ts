import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  APP_DISABLED_MESSAGE,
  WORKSPACE_APPS,
  appEnabled,
  appEnabledFilter,
  isWorkspaceApp,
  setAppEnabled,
} from "./apps.service.js";
import { Workspace } from "./models/Workspace.js";
import { fakeDoc, fakeQuery } from "../../test-support/mongoose-fakes.js";

const WID = "66f1a2b3c4d5e6f708192a3b";

function workspace(apps: Record<string, unknown>) {
  return fakeDoc({ apps });
}

describe("isWorkspaceApp", () => {
  test("recognises every app id and nothing else", () => {
    for (const app of WORKSPACE_APPS) assert.equal(isWorkspaceApp(app), true);
    assert.equal(isWorkspaceApp("billing"), false);
    assert.equal(isWorkspaceApp(""), false);
    assert.equal(isWorkspaceApp(undefined), false);
  });
});

describe("APP_DISABLED_MESSAGE", () => {
  test("has a message naming each app", () => {
    for (const app of WORKSPACE_APPS) {
      assert.match(APP_DISABLED_MESSAGE[app], /^Quantalog .+ is off for this workspace\. Turn it on in Apps\.$/);
    }
  });
});

describe("appEnabledFilter", () => {
  test("builds the query for workspaces with the app on", () => {
    assert.deepEqual(appEnabledFilter("compare"), { "apps.compare.enabled": true });
  });

  test("requires payment for public dashboards", () => {
    assert.deepEqual(appEnabledFilter("publicDashboard"), {
      "apps.publicDashboard.enabled": true,
      "apps.publicDashboard.paidAt": { $exists: true },
    });
  });
});

describe("appEnabled", () => {
  test("is true for a free app that is switched on", () => {
    assert.equal(appEnabled(workspace({ compare: { enabled: true } }), "compare"), true);
  });

  test("is false when the flag is off or missing", () => {
    assert.equal(appEnabled(workspace({ compare: { enabled: false } }), "compare"), false);
    assert.equal(appEnabled(workspace({}), "goals"), false);
  });

  test("needs a payment for a paid app turned on after it became paid", () => {
    assert.equal(appEnabled(workspace({ reviews: { enabled: true } }), "reviews"), false);
    assert.equal(appEnabled(workspace({ reviews: { enabled: true, paidAt: new Date() } }), "reviews"), true);
  });

  test("keeps a paid app free for workspaces that turned it on earlier", () => {
    assert.equal(appEnabled(workspace({ reviews: { enabled: true, enabledAt: new Date() } }), "reviews"), true);
  });

  test("always needs a payment for payment-only apps", () => {
    assert.equal(appEnabled(workspace({ notes: { enabled: true, enabledAt: new Date() } }), "notes"), false);
    assert.equal(appEnabled(workspace({ popups: { enabled: true, paidAt: new Date() } }), "popups"), true);
  });
});

describe("setAppEnabled", () => {
  test("turns an app on and stamps when", async (t) => {
    const updated = fakeDoc({ apps: { alerts: { enabled: true } } });
    const update = t.mock.method(Workspace, "findByIdAndUpdate", () => fakeQuery(updated));

    assert.deepEqual(await setAppEnabled(WID, "alerts", true), { alerts: { enabled: true } });
    const [id, change, options] = update.mock.calls[0].arguments as [string, { $set: Record<string, unknown> }, { new: boolean }];
    assert.equal(id, WID);
    assert.equal(change.$set["apps.alerts.enabled"], true);
    assert.ok(change.$set["apps.alerts.enabledAt"] instanceof Date);
    assert.equal(options.new, true);
  });

  test("turns an app off without touching enabledAt", async (t) => {
    const update = t.mock.method(Workspace, "findByIdAndUpdate", () => fakeQuery(fakeDoc({ apps: {} })));
    await setAppEnabled(WID, "alerts", false);
    const change = update.mock.calls[0].arguments[1] as { $set: Record<string, unknown> };
    assert.deepEqual(change.$set, { "apps.alerts.enabled": false });
  });

  test("returns null when the workspace is gone", async (t) => {
    t.mock.method(Workspace, "findByIdAndUpdate", () => fakeQuery(null));
    assert.equal(await setAppEnabled(WID, "goals", true), null);
  });
});
