import { test, describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appPrice, appUnlocked, listAppPrices, unlockApp } from "./paid-apps.js";
import { AppPrice } from "./models/AppPrice.js";
import { AppSetting } from "../../config/AppSetting.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { DEFAULT_APP_PRICE_INR, PAID_APPS } from "./paid-apps.catalog.js";
import { fakeDoc, fakeQuery } from "../../test-support/mongoose-fakes.js";

const WID = "66f1a2b3c4d5e6f708192a3b";

function stubPrices(t: TestContext, rows: { appId: string; price: Record<string, number> }[], usdRate: number | null) {
  t.mock.method(AppPrice, "find", () => fakeQuery(rows));
  t.mock.method(AppSetting, "findOne", () =>
    fakeQuery(usdRate === null ? null : fakeDoc({ value: { rates: { USD: usdRate }, fetchedAt: "x" } })),
  );
}

describe("listAppPrices", () => {
  test("lists every paid app at the default price with no FX rate yet", async (t) => {
    stubPrices(t, [], null);
    const prices = await listAppPrices();
    assert.deepEqual(
      prices.map((p) => p.appId),
      [...PAID_APPS],
    );
    for (const p of prices) assert.deepEqual(p.price, { INR: DEFAULT_APP_PRICE_INR, USD: 0 });
    assert.equal(prices.find((p) => p.appId === "reviews")?.name, "Quantalog Reviews");
  });

  test("derives foreign prices from the INR price with the stored rate", async (t) => {
    stubPrices(t, [{ appId: "alerts", price: { INR: 99900 } }], 0.012);
    const alerts = (await listAppPrices()).find((p) => p.appId === "alerts");
    assert.deepEqual(alerts?.price, { INR: 99900, USD: Math.round(99900 * 0.012) });
  });

  test("keeps a foreign price an admin set by hand", async (t) => {
    stubPrices(t, [{ appId: "notes", price: { INR: 59900, USD: 699 } }], 0.012);
    const notes = (await listAppPrices()).find((p) => p.appId === "notes");
    assert.deepEqual(notes?.price, { INR: 59900, USD: 699 });
  });

  test("uses the default when the stored INR price is zero", async (t) => {
    stubPrices(t, [{ appId: "links", price: { INR: 0 } }], null);
    const links = (await listAppPrices()).find((p) => p.appId === "links");
    assert.equal(links?.price.INR, DEFAULT_APP_PRICE_INR);
  });
});

describe("appPrice", () => {
  test("returns one app's price in one currency", async (t) => {
    stubPrices(t, [{ appId: "bio", price: { INR: 49900, USD: 599 } }], null);
    assert.equal(await appPrice("bio", "USD"), 599);
    assert.equal(await appPrice("bio", "INR"), 49900);
  });
});

describe("appUnlocked", () => {
  test("follows the paid apps rules", () => {
    assert.equal(appUnlocked(fakeDoc({ apps: {} }), "compare"), true);
    assert.equal(appUnlocked(fakeDoc({ apps: {} }), "popups"), false);
    assert.equal(appUnlocked(fakeDoc({ apps: { popups: { paidAt: new Date() } } }), "popups"), true);
  });
});

describe("unlockApp", () => {
  test("marks the app paid and turns it on", async (t) => {
    const update = t.mock.method(Workspace, "updateOne", async () => ({}));
    await unlockApp(WID, "notes");
    const [filter, change] = update.mock.calls[0].arguments as [unknown, { $set: Record<string, unknown> }];
    assert.deepEqual(filter, { _id: WID });
    assert.equal(change.$set["apps.notes.enabled"], true);
    assert.ok(change.$set["apps.notes.paidAt"] instanceof Date);
    assert.equal(change.$set["apps.notes.paidAt"], change.$set["apps.notes.enabledAt"]);
  });
});
