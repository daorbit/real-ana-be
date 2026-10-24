import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyCoupon, claimCoupon, planPurchaseLabel, redeemCoupon } from "./coupons.js";
import { Coupon } from "./models/Coupon.js";
import { fakeDoc, fakeQuery } from "../../test-support/mongoose-fakes.js";

const OWNER = "65a2b3c4d5e6f708192a3b4c";

function coupon(fields: Record<string, unknown>) {
  return fakeDoc({ code: "SAVE20", active: true, percentOff: 20, uses: 0, maxUses: 0, ...fields });
}

describe("applyCoupon", () => {
  test("returns the amount unchanged and skips the lookup without a code", async (t) => {
    const findOne = t.mock.method(Coupon, "findOne", () => fakeQuery(null));
    assert.deepEqual(await applyCoupon(99900, undefined), { amount: 99900 });
    assert.deepEqual(await applyCoupon(99900, "   "), { amount: 99900 });
    assert.equal(findOne.mock.callCount(), 0);
  });

  test("normalises the code before looking it up", async (t) => {
    const findOne = t.mock.method(Coupon, "findOne", () => fakeQuery(coupon({})));
    await applyCoupon(1000, "  save20 ");
    assert.deepEqual(findOne.mock.calls[0].arguments[0], { code: "SAVE20" });
  });

  test("applies the discount, rounding down in the customer's favour", async (t) => {
    t.mock.method(Coupon, "findOne", () => fakeQuery(coupon({ percentOff: 33 })));
    assert.deepEqual(await applyCoupon(99900, "save20"), {
      amount: Math.floor((99900 * 67) / 100),
      coupon: { code: "SAVE20", percentOff: 33 },
    });
  });

  test("makes a 100% coupon free", async (t) => {
    t.mock.method(Coupon, "findOne", () => fakeQuery(coupon({ percentOff: 100 })));
    assert.equal((await applyCoupon(149900, "SAVE20")).amount, 0);
  });

  test("refuses unknown and inactive codes with the same message", async (t) => {
    const lookup = t.mock.method(Coupon, "findOne", () => fakeQuery(null));
    assert.deepEqual(await applyCoupon(1000, "NOPE"), { amount: 1000, error: "coupon not found" });
    lookup.mock.mockImplementation(() => fakeQuery(coupon({ active: false })));
    assert.deepEqual(await applyCoupon(1000, "SAVE20"), { amount: 1000, error: "coupon not found" });
  });

  test("hides personal coupons from everyone but their owner", async (t) => {
    t.mock.method(Coupon, "findOne", () => fakeQuery(coupon({ ownerId: OWNER })));
    assert.equal((await applyCoupon(1000, "SAVE20", "someone-else")).error, "coupon not found");
    assert.equal((await applyCoupon(1000, "SAVE20")).error, "coupon not found");
    assert.equal((await applyCoupon(1000, "SAVE20", OWNER)).amount, 800);
  });

  test("refuses expired coupons", async (t) => {
    t.mock.method(Coupon, "findOne", () => fakeQuery(coupon({ expiresAt: new Date(Date.now() - 1000) })));
    assert.deepEqual(await applyCoupon(1000, "SAVE20"), { amount: 1000, error: "coupon has expired" });
  });

  test("accepts coupons that have not expired yet", async (t) => {
    t.mock.method(Coupon, "findOne", () => fakeQuery(coupon({ expiresAt: new Date(Date.now() + 60_000) })));
    assert.equal((await applyCoupon(1000, "SAVE20")).amount, 800);
  });

  test("refuses coupons that reached their use limit", async (t) => {
    t.mock.method(Coupon, "findOne", () => fakeQuery(coupon({ maxUses: 3, uses: 3 })));
    assert.deepEqual(await applyCoupon(1000, "SAVE20"), { amount: 1000, error: "coupon has already been used" });
  });

  test("treats a missing use count as unused", async (t) => {
    t.mock.method(Coupon, "findOne", () => fakeQuery(coupon({ maxUses: 1, uses: undefined })));
    assert.equal((await applyCoupon(1000, "SAVE20")).amount, 800);
  });
});

describe("claimCoupon", () => {
  test("is a no-op success without a code", async (t) => {
    const claim = t.mock.method(Coupon, "findOneAndUpdate", () => fakeQuery(null));
    assert.equal(await claimCoupon(""), true);
    assert.equal(await claimCoupon(undefined), true);
    assert.equal(claim.mock.callCount(), 0);
  });

  test("claims one use atomically only while uses remain", async (t) => {
    const claim = t.mock.method(Coupon, "findOneAndUpdate", () => fakeQuery(coupon({})));
    assert.equal(await claimCoupon(" save20 ", "plan:starter"), true);

    const [filter, change] = claim.mock.calls[0].arguments as [
      { code: string; active: boolean; $or: unknown[] },
      { $inc: { uses: number }; $set: { usedAt: Date; usedFor?: string } },
    ];
    assert.equal(filter.code, "SAVE20");
    assert.equal(filter.active, true);
    assert.equal(filter.$or.length, 2);
    assert.deepEqual(change.$inc, { uses: 1 });
    assert.equal(change.$set.usedFor, "plan:starter");
    assert.ok(change.$set.usedAt instanceof Date);
  });

  test("returns false when the coupon is used up or gone", async (t) => {
    t.mock.method(Coupon, "findOneAndUpdate", () => fakeQuery(null));
    assert.equal(await claimCoupon("SAVE20"), false);
  });

  test("leaves usedFor alone when no purpose is given", async (t) => {
    const claim = t.mock.method(Coupon, "findOneAndUpdate", () => fakeQuery(coupon({})));
    await claimCoupon("SAVE20");
    const change = claim.mock.calls[0].arguments[1] as { $set: Record<string, unknown> };
    assert.equal("usedFor" in change.$set, false);
  });
});

describe("redeemCoupon", () => {
  test("does nothing without a code", async (t) => {
    const update = t.mock.method(Coupon, "updateOne", async () => ({}));
    await redeemCoupon(null);
    assert.equal(update.mock.callCount(), 0);
  });

  test("counts a use against the normalised code", async (t) => {
    const update = t.mock.method(Coupon, "updateOne", async () => ({}));
    await redeemCoupon("save20", "addon:events");
    const [filter, change] = update.mock.calls[0].arguments as [unknown, { $inc: unknown; $set: { usedFor: string } }];
    assert.deepEqual(filter, { code: "SAVE20" });
    assert.deepEqual(change.$inc, { uses: 1 });
    assert.equal(change.$set.usedFor, "addon:events");
  });
});

describe("planPurchaseLabel", () => {
  test("names analytics plans from the catalogue", () => {
    assert.equal(planPurchaseLabel(undefined, "pro"), "Pro plan");
    assert.equal(planPurchaseLabel("analytics", "starter"), "Starter plan");
  });

  test("names Orbit plans from the Orbit catalogue", () => {
    assert.equal(planPurchaseLabel("orbit", "orbit-pro"), "Orbit Pro plan");
  });

  test("falls back to the slug for unknown plans", () => {
    assert.equal(planPurchaseLabel(undefined, "legacy-gold"), "legacy-gold plan");
  });
});
