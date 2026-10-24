import { test, describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { canIngest, countEvents, invalidateSite } from "./event-quota.js";
import { Subscription } from "./models/Subscription.js";
import { Site } from "../analytics/models/Site.js";
import { getPlanCatalogEntry } from "./plans.catalog.js";
import { fakeDoc, fakeQuery } from "../../test-support/mongoose-fakes.js";

const DAY = 24 * 60 * 60 * 1000;
let counter = 0;

function freshId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function stubBilling(t: TestContext, sub: Record<string, unknown> | null) {
  t.mock.method(Subscription, "updateOne", async () => ({}));
  t.mock.method(Subscription, "findOneAndUpdate", () => fakeQuery(null));
  return t.mock.method(Subscription, "findOne", () => fakeQuery(sub ? fakeDoc(sub) : null));
}

function stubSites(t: TestContext, workspaceBySite: Record<string, string>) {
  return t.mock.method(Site, "findOne", (filter: { siteId: string }) => {
    const workspaceId = workspaceBySite[filter.siteId];
    return fakeQuery(workspaceId ? fakeDoc({ workspaceId }) : null);
  });
}

describe("canIngest", () => {
  test("refuses events for an unknown site", async (t) => {
    stubBilling(t, null);
    stubSites(t, {});
    assert.deepEqual(await canIngest(freshId("ghost")), { allowed: false, workspaceId: null });
  });

  test("allows events while the plan's monthly allowance lasts", async (t) => {
    const site = freshId("site");
    const wid = freshId("ws");
    stubBilling(t, { planSlug: "starter", currentPeriodEnd: new Date(Date.now() + DAY), eventsUsed: 10 });
    stubSites(t, { [site]: wid });
    assert.deepEqual(await canIngest(site), { allowed: true, workspaceId: wid });
  });

  test("refuses once the allowance is used up", async (t) => {
    const site = freshId("site");
    const quota = getPlanCatalogEntry("starter")!.monthlyEventQuota;
    stubBilling(t, { planSlug: "starter", currentPeriodEnd: new Date(Date.now() + DAY), eventsUsed: quota });
    stubSites(t, { [site]: freshId("ws") });
    assert.equal((await canIngest(site)).allowed, false);
  });

  test("falls back to the Free allowance when the paid period has lapsed", async (t) => {
    const site = freshId("site");
    const free = getPlanCatalogEntry("free")!.monthlyEventQuota;
    stubBilling(t, { planSlug: "pro", currentPeriodEnd: new Date(Date.now() - DAY), eventsUsed: free });
    stubSites(t, { [site]: freshId("ws") });
    assert.equal((await canIngest(site)).allowed, false);
  });

  test("treats a subscription without a period end as lapsed", async (t) => {
    const site = freshId("site");
    stubBilling(t, { planSlug: "pro", currentPeriodEnd: null, eventsUsed: getPlanCatalogEntry("free")!.monthlyEventQuota });
    stubSites(t, { [site]: freshId("ws") });
    assert.equal((await canIngest(site)).allowed, false);
  });

  test("refuses when the workspace has no subscription", async (t) => {
    const site = freshId("site");
    stubBilling(t, null);
    stubSites(t, { [site]: freshId("ws") });
    assert.equal((await canIngest(site)).allowed, false);
  });

  test("remembers the decision for a minute instead of querying every beacon", async (t) => {
    const site = freshId("site");
    stubBilling(t, { planSlug: "starter", currentPeriodEnd: new Date(Date.now() + DAY), eventsUsed: 0 });
    const lookup = stubSites(t, { [site]: freshId("ws") });
    await canIngest(site);
    await canIngest(site);
    assert.equal(lookup.mock.callCount(), 1);
  });

  test("asks again after the site is invalidated", async (t) => {
    const site = freshId("site");
    stubBilling(t, { planSlug: "starter", currentPeriodEnd: new Date(Date.now() + DAY), eventsUsed: 0 });
    const lookup = stubSites(t, { [site]: freshId("ws") });
    await canIngest(site);
    invalidateSite(site);
    await canIngest(site);
    assert.equal(lookup.mock.callCount(), 2);
  });

  test("closes every cached site of a workspace once it runs out", async (t) => {
    const first = freshId("site");
    const second = freshId("site");
    const wid = freshId("ws");
    const quota = getPlanCatalogEntry("starter")!.monthlyEventQuota;
    const sub = stubBilling(t, { planSlug: "starter", currentPeriodEnd: new Date(Date.now() + DAY), eventsUsed: 0 });
    const lookup = stubSites(t, { [first]: wid, [second]: wid });

    assert.equal((await canIngest(first)).allowed, true);
    sub.mock.mockImplementation(() =>
      fakeQuery(fakeDoc({ planSlug: "starter", currentPeriodEnd: new Date(Date.now() + DAY), eventsUsed: quota })),
    );
    assert.equal((await canIngest(second)).allowed, false);
    assert.equal((await canIngest(first)).allowed, false);
    assert.equal(lookup.mock.callCount(), 2);
  });
});

describe("countEvents", () => {
  test("adds the batch size to the workspace's usage", async (t) => {
    const wid = freshId("ws");
    const update = t.mock.method(Subscription, "updateOne", async () => ({}));
    t.mock.method(Subscription, "findOneAndUpdate", () => fakeQuery(null));
    await countEvents(wid, 25);
    const last = update.mock.calls.at(-1)?.arguments;
    assert.deepEqual(last, [{ workspaceId: wid }, { $inc: { eventsUsed: 25 } }]);
  });

  test("ignores empty batches", async (t) => {
    const update = t.mock.method(Subscription, "updateOne", async () => ({}));
    await countEvents(freshId("ws"), 0);
    await countEvents(freshId("ws"), -3);
    assert.equal(update.mock.callCount(), 0);
  });

  test("never fails the ingest when counting fails", async (t) => {
    t.mock.method(console, "error", () => {});
    t.mock.method(Subscription, "updateOne", async () => {
      throw new Error("mongo down");
    });
    t.mock.method(Subscription, "findOneAndUpdate", () => fakeQuery(null));
    await assert.doesNotReject(countEvents(freshId("ws"), 5));
  });
});
