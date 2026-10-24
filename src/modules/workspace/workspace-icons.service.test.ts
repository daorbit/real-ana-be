import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { workspaceIcons } from "./workspace-icons.service.js";
import { Branding } from "../branding/models/Branding.js";
import { Site } from "../analytics/models/Site.js";
import { fakeQuery } from "../../test-support/mongoose-fakes.js";

const A = "66f1a2b3c4d5e6f708192a3b";
const B = "77f1a2b3c4d5e6f708192a3b";
const C = "88f1a2b3c4d5e6f708192a3b";

describe("workspaceIcons", () => {
  test("does not query for an empty list", async (t) => {
    const brands = t.mock.method(Branding, "find", () => fakeQuery([]));
    const sites = t.mock.method(Site, "find", () => fakeQuery([]));
    assert.equal((await workspaceIcons([])).size, 0);
    assert.equal(brands.mock.callCount(), 0);
    assert.equal(sites.mock.callCount(), 0);
  });

  test("prefers the brand logo and falls back to the first site logo", async (t) => {
    t.mock.method(Branding, "find", () => fakeQuery([{ workspaceId: A, logoUrl: "https://cdn/brand-a.png" }]));
    t.mock.method(Site, "find", () =>
      fakeQuery([
        { workspaceId: A, logoUrl: "https://cdn/site-a.png" },
        { workspaceId: B, logoUrl: "https://cdn/site-b1.png" },
        { workspaceId: B, logoUrl: "https://cdn/site-b2.png" },
      ]),
    );

    const icons = await workspaceIcons([A, B, C]);
    assert.deepEqual(icons.get(A), { logoUrl: "https://cdn/brand-a.png", brandLogoUrl: "https://cdn/brand-a.png" });
    assert.deepEqual(icons.get(B), { logoUrl: "https://cdn/site-b1.png", brandLogoUrl: null });
    assert.equal(icons.has(C), false);
  });

  test("ignores logos that are not https", async (t) => {
    t.mock.method(Branding, "find", () =>
      fakeQuery([
        { workspaceId: A, logoUrl: "http://cdn/brand.png" },
        { workspaceId: B, logoUrl: "   " },
      ]),
    );
    t.mock.method(Site, "find", () =>
      fakeQuery([
        { workspaceId: A, logoUrl: "javascript:alert(1)" },
        { workspaceId: A, logoUrl: "  https://cdn/ok.png  " },
      ]),
    );

    const icons = await workspaceIcons([A, B]);
    assert.deepEqual(icons.get(A), { logoUrl: "https://cdn/ok.png", brandLogoUrl: null });
    assert.equal(icons.has(B), false);
  });

  test("bounds the site lookup and orders it oldest first", async (t) => {
    t.mock.method(Branding, "find", () => fakeQuery([]));
    const query = fakeQuery([]);
    const sites = t.mock.method(Site, "find", () => query);
    await workspaceIcons([A, B]);

    assert.deepEqual(sites.mock.calls[0].arguments[0], { workspaceId: { $in: [A, B] }, logoUrl: { $nin: [null, ""] } });
    assert.deepEqual(
      query.steps.filter((s) => s.method === "sort" || s.method === "limit"),
      [
        { method: "sort", args: [{ createdAt: 1 }] },
        { method: "limit", args: [50] },
      ],
    );
  });
});
