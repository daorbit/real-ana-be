import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MAX_WIDGETS, parseLayout } from "./layout.js";

describe("parseLayout", () => {
  test("accepts a valid layout and keeps only id and span", () => {
    assert.deepEqual(
      parseLayout([
        { id: "traffic", span: 4, extra: true },
        { id: "live", span: 1 },
      ]),
      [
        { id: "traffic", span: 4 },
        { id: "live", span: 1 },
      ],
    );
  });

  test("accepts an empty layout", () => {
    assert.deepEqual(parseLayout([]), []);
  });

  test("rejects anything that is not an array", () => {
    assert.equal(parseLayout(null), null);
    assert.equal(parseLayout({ id: "x", span: 1 }), null);
    assert.equal(parseLayout("[]"), null);
  });

  test("rejects more than the widget limit", () => {
    const tooMany = Array.from({ length: MAX_WIDGETS + 1 }, (_, i) => ({ id: `w${i}`, span: 1 }));
    assert.equal(parseLayout(tooMany), null);
    assert.equal(parseLayout(tooMany.slice(0, MAX_WIDGETS))?.length, MAX_WIDGETS);
  });

  test("rejects missing, empty or overlong ids", () => {
    assert.equal(parseLayout([{ span: 1 }]), null);
    assert.equal(parseLayout([{ id: "", span: 1 }]), null);
    assert.equal(parseLayout([{ id: 7, span: 1 }]), null);
    assert.equal(parseLayout([{ id: "x".repeat(65), span: 1 }]), null);
    assert.ok(parseLayout([{ id: "x".repeat(64), span: 1 }]));
  });

  test("rejects spans outside one to four", () => {
    for (const span of [0, 5, 2.5, "2", null]) {
      assert.equal(parseLayout([{ id: "x", span }]), null, `span ${String(span)}`);
    }
  });

  test("rejects null entries", () => {
    assert.equal(parseLayout([null]), null);
  });
});
