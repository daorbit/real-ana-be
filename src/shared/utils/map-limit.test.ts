import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mapLimit } from "./map-limit.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("mapLimit", () => {
  test("keeps results in input order", async () => {
    const out = await mapLimit([30, 10, 20], 2, async (n) => {
      await new Promise((resolve) => setTimeout(resolve, n));
      return n * 2;
    });
    assert.deepEqual(out, [60, 20, 40]);
  });

  test("never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick();
      running -= 1;
    });
    assert.equal(peak, 3);
  });

  test("handles an empty list", async () => {
    assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  });

  test("passes the index", async () => {
    assert.deepEqual(await mapLimit(["a", "b"], 1, async (s, i) => `${s}${i}`), ["a0", "b1"]);
  });

  test("rejects when a task fails", async () => {
    await assert.rejects(
      mapLimit([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
      /boom/,
    );
  });
});
