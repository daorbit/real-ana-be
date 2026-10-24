import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { asPriceMap, getResolvedPlan, listResolvedPlans } from "./plan-pricing.js";
import { Plan } from "./models/Plan.js";
import { PLAN_CATALOG } from "./plans.catalog.js";
import { fakeDoc, fakeQuery } from "../../test-support/mongoose-fakes.js";

describe("asPriceMap", () => {
  test("returns undefined for empty values", () => {
    assert.equal(asPriceMap(undefined), undefined);
    assert.equal(asPriceMap(null), undefined);
  });

  test("unwraps Mongoose subdocuments", () => {
    assert.deepEqual(asPriceMap({ toObject: () => ({ INR: 100 }) }), { INR: 100 });
  });

  test("passes plain objects through", () => {
    const prices = { INR: 100, USD: 2 };
    assert.equal(asPriceMap(prices), prices);
  });
});

describe("listResolvedPlans", () => {
  test("returns every catalogue plan with stored prices and zeros for the rest", async (t) => {
    const find = t.mock.method(Plan, "find", () =>
      fakeQuery([
        fakeDoc({ slug: "starter", priceMonthly: { toObject: () => ({ INR: 149900, USD: 1800 }) }, priceYearly: { INR: 1499000 } }),
      ]),
    );

    const plans = await listResolvedPlans();
    assert.deepEqual(
      plans.map((p) => p.slug),
      PLAN_CATALOG.map((p) => p.slug),
    );
    const starter = plans.find((p) => p.slug === "starter");
    assert.deepEqual(starter?.priceMonthly, { INR: 149900, USD: 1800 });
    assert.deepEqual(starter?.priceYearly, { INR: 1499000, USD: 0 });
    assert.deepEqual(plans.find((p) => p.slug === "free")?.priceMonthly, { INR: 0, USD: 0 });
    assert.deepEqual(find.mock.calls[0].arguments[0], { slug: { $in: PLAN_CATALOG.map((p) => p.slug) } });
  });

  test("keeps the catalogue limits on each plan", async (t) => {
    t.mock.method(Plan, "find", () => fakeQuery([]));
    const plans = await listResolvedPlans();
    for (const plan of plans) {
      const entry = PLAN_CATALOG.find((p) => p.slug === plan.slug);
      assert.equal(plan.monthlyEventQuota, entry?.monthlyEventQuota);
    }
  });
});

describe("getResolvedPlan", () => {
  test("returns null for a slug that is not a plan, without a query", async (t) => {
    const findOne = t.mock.method(Plan, "findOne", () => fakeQuery(null));
    assert.equal(await getResolvedPlan("enterprise"), null);
    assert.equal(findOne.mock.callCount(), 0);
  });

  test("returns the plan with its prices", async (t) => {
    t.mock.method(Plan, "findOne", () => fakeQuery(fakeDoc({ slug: "pro", priceMonthly: { INR: 499900 } })));
    const plan = await getResolvedPlan("pro");
    assert.equal(plan?.name, "Pro");
    assert.deepEqual(plan?.priceMonthly, { INR: 499900, USD: 0 });
    assert.deepEqual(plan?.priceYearly, { INR: 0, USD: 0 });
  });

  test("returns zero prices when no price row exists yet", async (t) => {
    t.mock.method(Plan, "findOne", () => fakeQuery(null));
    assert.deepEqual((await getResolvedPlan("free"))?.priceMonthly, { INR: 0, USD: 0 });
  });
});
