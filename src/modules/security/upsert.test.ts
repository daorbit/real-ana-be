import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { retryOnDuplicateKey } from "./upsert.js";
import { duplicateKeyError } from "../../test-support/mongoose-fakes.js";

describe("retryOnDuplicateKey", () => {
  test("returns the first result when nothing goes wrong", async (t) => {
    const run = t.mock.fn(async () => "first");
    assert.equal(await retryOnDuplicateKey(run), "first");
    assert.equal(run.mock.callCount(), 1);
  });

  test("runs once more after a duplicate key error from a racing upsert", async (t) => {
    let calls = 0;
    const run = t.mock.fn(async () => {
      calls += 1;
      if (calls === 1) throw duplicateKeyError();
      return "second";
    });
    assert.equal(await retryOnDuplicateKey(run), "second");
    assert.equal(run.mock.callCount(), 2);
  });

  test("rethrows any other error without retrying", async (t) => {
    const run = t.mock.fn(async () => {
      throw new Error("connection lost");
    });
    await assert.rejects(retryOnDuplicateKey(run), /connection lost/);
    assert.equal(run.mock.callCount(), 1);
  });

  test("gives up after one retry", async (t) => {
    const run = t.mock.fn(async () => {
      throw duplicateKeyError();
    });
    await assert.rejects(retryOnDuplicateKey(run), (e: { code?: number }) => e.code === 11000);
    assert.equal(run.mock.callCount(), 2);
  });
});
