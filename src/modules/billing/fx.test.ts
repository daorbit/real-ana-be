import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { FX_BASE, convertMinor, fetchRates, fxConfigured, getCachedRates, type FxSnapshot } from "./fx.js";
import { AppSetting } from "../../config/AppSetting.js";
import { fakeDoc, fakeQuery } from "../../test-support/mongoose-fakes.js";

const SNAPSHOT: FxSnapshot = { rates: { USD: 0.012 }, fetchedAt: "2026-10-24T00:00:00.000Z" };
const ORIGINAL_KEY = process.env.EXCHANGERATE_API_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.EXCHANGERATE_API_KEY;
  else process.env.EXCHANGERATE_API_KEY = ORIGINAL_KEY;
});

describe("convertMinor", () => {
  test("returns the base currency unchanged", () => {
    assert.equal(FX_BASE, "INR");
    assert.equal(convertMinor(99900, "INR", SNAPSHOT), 99900);
  });

  test("converts and rounds to the nearest minor unit", () => {
    assert.equal(convertMinor(99900, "USD", SNAPSHOT), Math.round(99900 * 0.012));
    assert.equal(convertMinor(1, "USD", { ...SNAPSHOT, rates: { USD: 0.6 } }), 1);
    assert.equal(convertMinor(1, "USD", { ...SNAPSHOT, rates: { USD: 0.4 } }), 0);
  });

  test("never returns a negative amount", () => {
    assert.equal(convertMinor(-500, "USD", SNAPSHOT), 0);
  });

  test("throws when the rate is missing or unusable", () => {
    assert.throws(() => convertMinor(100, "USD", { ...SNAPSHOT, rates: {} }), /no rate available for USD/);
    assert.throws(() => convertMinor(100, "USD", { ...SNAPSHOT, rates: { USD: 0 } }), /no rate available/);
    assert.throws(() => convertMinor(100, "USD", { ...SNAPSHOT, rates: { USD: Number.NaN } }), /no rate available/);
  });
});

describe("fxConfigured", () => {
  test("follows the API key", () => {
    delete process.env.EXCHANGERATE_API_KEY;
    assert.equal(fxConfigured(), false);
    process.env.EXCHANGERATE_API_KEY = "k";
    assert.equal(fxConfigured(), true);
  });
});

describe("getCachedRates", () => {
  test("returns the stored snapshot", async (t) => {
    const find = t.mock.method(AppSetting, "findOne", () => fakeQuery(fakeDoc({ value: SNAPSHOT })));
    assert.deepEqual(await getCachedRates(), SNAPSHOT);
    assert.deepEqual(find.mock.calls[0].arguments[0], { key: "fx.rates" });
  });

  test("returns null when nothing or nothing usable is stored", async (t) => {
    const find = t.mock.method(AppSetting, "findOne", () => fakeQuery(null));
    assert.equal(await getCachedRates(), null);
    find.mock.mockImplementation(() => fakeQuery(fakeDoc({ value: { rates: {} } })));
    assert.equal(await getCachedRates(), null);
  });
});

describe("fetchRates", () => {
  test("refuses to run without an API key", async () => {
    delete process.env.EXCHANGERATE_API_KEY;
    await assert.rejects(fetchRates(), /EXCHANGERATE_API_KEY is not set/);
  });

  test("stores and returns the INR to USD rate", async (t) => {
    process.env.EXCHANGERATE_API_KEY = "secret-key";
    const get = t.mock.method(axios, "get", async () => ({
      data: { result: "success", conversion_rates: { USD: 0.0119 }, time_next_update_unix: 1_793_000_000 },
    }));
    const save = t.mock.method(AppSetting, "updateOne", async () => ({}));

    const snapshot = await fetchRates();
    assert.deepEqual(snapshot.rates, { USD: 0.0119 });
    assert.equal(snapshot.nextUpdateAt, new Date(1_793_000_000 * 1000).toISOString());
    assert.match(String(get.mock.calls[0].arguments[0]), /\/secret-key\/latest\/INR$/);
    const [filter, change, options] = save.mock.calls[0].arguments as [unknown, { $set: { value: FxSnapshot } }, unknown];
    assert.deepEqual(filter, { key: "fx.rates" });
    assert.deepEqual(change.$set.value, snapshot);
    assert.deepEqual(options, { upsert: true });
  });

  test("reports the provider's error type", async (t) => {
    process.env.EXCHANGERATE_API_KEY = "bad";
    t.mock.method(axios, "get", async () => ({ data: { result: "error", "error-type": "invalid-key" } }));
    const save = t.mock.method(AppSetting, "updateOne", async () => ({}));
    await assert.rejects(fetchRates(), /exchangerate-api: invalid-key/);
    assert.equal(save.mock.callCount(), 0);
  });

  test("refuses a response without a usable USD rate", async (t) => {
    process.env.EXCHANGERATE_API_KEY = "k";
    t.mock.method(axios, "get", async () => ({ data: { result: "success", conversion_rates: { USD: -1 } } }));
    t.mock.method(AppSetting, "updateOne", async () => ({}));
    await assert.rejects(fetchRates(), /no usable USD rate/);
  });

  test("leaves nextUpdateAt empty when the provider does not say", async (t) => {
    process.env.EXCHANGERATE_API_KEY = "k";
    t.mock.method(axios, "get", async () => ({ data: { result: "success", conversion_rates: { USD: 0.012 } } }));
    t.mock.method(AppSetting, "updateOne", async () => ({}));
    assert.equal((await fetchRates()).nextUpdateAt, undefined);
  });
});
