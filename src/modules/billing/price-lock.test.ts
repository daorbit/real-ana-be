import { test, describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { PRICE_CHANGE_CUTOFF, applyPriceLock } from "./price-lock.js";
import { PlanPurchase } from "./models/PlanPurchase.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { getPlanCatalogEntry } from "./plans.catalog.js";
import type { ResolvedPlan } from "./plan-pricing.js";
import { fakeDoc, fakeQuery } from "../../test-support/mongoose-fakes.js";

const WID = "66f1a2b3c4d5e6f708192a3b";
const OWNER = "65a2b3c4d5e6f708192a3b4c";

function plan(slug: string, monthly: { INR: number; USD: number }, yearly: { INR: number; USD: number }): ResolvedPlan {
  return { ...getPlanCatalogEntry(slug)!, priceMonthly: monthly, priceYearly: yearly };
}

function stubHistory(t: TestContext, paid: boolean, oldestWorkspace = WID) {
  t.mock.method(Workspace, "findById", () => fakeQuery(fakeDoc({ userId: OWNER })));
  t.mock.method(Workspace, "findOne", () => fakeQuery({ _id: oldestWorkspace }));
  return t.mock.method(PlanPurchase, "exists", async () => (paid ? { _id: "p1" } : null));
}

describe("applyPriceLock", () => {
  test("leaves plans without legacy prices alone and never queries", async (t) => {
    const exists = t.mock.method(PlanPurchase, "exists", async () => ({ _id: "p1" }));
    const free = plan("free", { INR: 0, USD: 0 }, { INR: 0, USD: 0 });
    assert.equal(await applyPriceLock(WID, free), free);
    assert.equal(exists.mock.callCount(), 0);
  });

  test("charges current prices to workspaces that never paid before the cutoff", async (t) => {
    stubHistory(t, false);
    const starter = plan("starter", { INR: 149900, USD: 1800 }, { INR: 1499000, USD: 18000 });
    assert.equal(await applyPriceLock(WID, starter), starter);
  });

  test("keeps the old price for workspaces that paid before the cutoff", async (t) => {
    stubHistory(t, true);
    const starter = plan("starter", { INR: 149900, USD: 1800 }, { INR: 1499000, USD: 18000 });
    const locked = await applyPriceLock(WID, starter);

    assert.deepEqual(locked.priceMonthly, { INR: 99900, USD: Math.round((99900 * 1800) / 149900) });
    assert.deepEqual(locked.priceYearly, { INR: 999900, USD: Math.round((999900 * 18000) / 1499000) });
    assert.equal(locked.slug, "starter");
  });

  test("never raises a price that is already below the legacy one", async (t) => {
    stubHistory(t, true);
    const cheaper = plan("pro", { INR: 500000, USD: 6000 }, { INR: 5000000, USD: 60000 });
    const locked = await applyPriceLock(WID, cheaper);
    assert.deepEqual(locked.priceMonthly, { INR: 500000, USD: 6000 });
  });

  test("keeps foreign prices when the base price is zero", async (t) => {
    stubHistory(t, true);
    const locked = await applyPriceLock(WID, plan("starter", { INR: 0, USD: 1800 }, { INR: 0, USD: 0 }));
    assert.deepEqual(locked.priceMonthly, { INR: 0, USD: 1800 });
  });

  test("only counts real paid purchases of the same plan before the cutoff", async (t) => {
    const exists = stubHistory(t, true);
    await applyPriceLock(WID, plan("starter", { INR: 149900, USD: 1800 }, { INR: 0, USD: 0 }));

    const filter = exists.mock.calls[0].arguments[0] as Record<string, unknown>;
    assert.equal(filter.planSlug, "starter");
    assert.equal(filter.status, "paid");
    assert.deepEqual(filter.gateway, { $ne: "coupon" });
    assert.deepEqual(filter.ladder, { $ne: "orbit" });
    assert.deepEqual(filter.createdAt, { $lt: PRICE_CHANGE_CUTOFF });
  });

  test("credits old account-level purchases only to the owner's first workspace", async (t) => {
    const exists = stubHistory(t, true, WID);
    await applyPriceLock(WID, plan("starter", { INR: 149900, USD: 0 }, { INR: 0, USD: 0 }));
    assert.deepEqual((exists.mock.calls[0].arguments[0] as { $or: unknown[] }).$or, [
      { workspaceId: WID },
      { workspaceId: null, userId: OWNER },
    ]);
  });

  test("does not credit account-level purchases to a later workspace", async (t) => {
    const exists = stubHistory(t, true, "77f1a2b3c4d5e6f708192a3b");
    await applyPriceLock(WID, plan("starter", { INR: 149900, USD: 0 }, { INR: 0, USD: 0 }));
    assert.deepEqual((exists.mock.calls[0].arguments[0] as { $or: unknown[] }).$or, [{ workspaceId: WID }]);
  });
});
