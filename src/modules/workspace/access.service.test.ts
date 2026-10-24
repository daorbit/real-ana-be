import { test, describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  accessibleWorkspaces,
  isDenied,
  requireWorkspace,
  resolveAccess,
  resolveAccessFor,
} from "./access.service.js";
import { Membership } from "./models/Membership.js";
import { Workspace } from "./models/Workspace.js";
import type { AuthedRequest } from "../../http/middleware/auth.js";
import { fakeDoc, fakeQuery, fakeResponse } from "../../test-support/mongoose-fakes.js";

const WID = "66f1a2b3c4d5e6f708192a3b";
const UID = "65a2b3c4d5e6f708192a3b4c";

function request(fields: { userId?: string; wid?: string }): AuthedRequest {
  return { userId: fields.userId, params: { wid: fields.wid } } as unknown as AuthedRequest;
}

function stubAccess(t: TestContext, role: string | null, exists = true) {
  const workspace = exists ? fakeDoc({ _id: WID, name: "Acme" }) : null;
  const membership = t.mock.method(Membership, "findOne", () => fakeQuery(role ? fakeDoc({ role }) : null));
  const lookup = t.mock.method(Workspace, "findById", () => fakeQuery(workspace));
  return { membership, lookup, workspace };
}

describe("resolveAccessFor", () => {
  test("answers 404 without querying when the user or workspace id is missing", async (t) => {
    const { membership, lookup } = stubAccess(t, "owner");
    assert.deepEqual(await resolveAccessFor(undefined, WID), { error: "workspace not found", status: 404 });
    assert.deepEqual(await resolveAccessFor(UID, undefined), { error: "workspace not found", status: 404 });
    assert.equal(membership.mock.callCount(), 0);
    assert.equal(lookup.mock.callCount(), 0);
  });

  test("answers 404, not 403, to non-members so ids cannot be probed", async (t) => {
    stubAccess(t, null);
    assert.deepEqual(await resolveAccessFor(UID, WID, "viewer"), { error: "workspace not found", status: 404 });
  });

  test("answers 404 when the membership outlived its workspace", async (t) => {
    stubAccess(t, "owner", false);
    assert.deepEqual(await resolveAccessFor(UID, WID), { error: "workspace not found", status: 404 });
  });

  test("answers 403 when the member's role is too low", async (t) => {
    stubAccess(t, "viewer");
    assert.deepEqual(await resolveAccessFor(UID, WID, "editor"), {
      error: "this needs editor access to the workspace — you have viewer access",
      status: 403,
    });
  });

  test("grants access at or above the minimum role", async (t) => {
    const { workspace } = stubAccess(t, "admin");
    for (const minimum of ["viewer", "editor", "admin"] as const) {
      assert.deepEqual(await resolveAccessFor(UID, WID, minimum), { workspace, role: "admin" });
    }
    assert.equal(isDenied(await resolveAccessFor(UID, WID, "owner")), true);
  });

  test("defaults to viewer access", async (t) => {
    stubAccess(t, "viewer");
    assert.equal(isDenied(await resolveAccessFor(UID, WID)), false);
  });

  test("looks up the membership and workspace by the given ids", async (t) => {
    const { membership, lookup } = stubAccess(t, "owner");
    await resolveAccessFor(UID, WID);
    assert.deepEqual(membership.mock.calls[0].arguments[0], { workspaceId: WID, userId: UID });
    assert.equal(lookup.mock.calls[0].arguments[0], WID);
  });
});

describe("resolveAccess", () => {
  test("reads the workspace id from the route", async (t) => {
    const { membership } = stubAccess(t, "editor");
    await resolveAccess(request({ userId: UID, wid: WID }), "editor");
    assert.deepEqual(membership.mock.calls[0].arguments[0], { workspaceId: WID, userId: UID });
  });

  test("prefers an explicit workspace id", async (t) => {
    const { membership } = stubAccess(t, "editor");
    await resolveAccess(request({ userId: UID, wid: "ignored" }), "viewer", WID);
    assert.deepEqual(membership.mock.calls[0].arguments[0], { workspaceId: WID, userId: UID });
  });
});

describe("requireWorkspace", () => {
  test("sends the refusal and returns null", async (t) => {
    stubAccess(t, "viewer");
    const res = fakeResponse();
    assert.equal(await requireWorkspace(request({ userId: UID, wid: WID }), res, "admin"), null);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "this needs admin access to the workspace — you have viewer access" });
  });

  test("returns the workspace document on success", async (t) => {
    const { workspace } = stubAccess(t, "owner");
    const res = fakeResponse();
    assert.equal(await requireWorkspace(request({ userId: UID, wid: WID }), res), workspace);
    assert.equal(res.body, undefined);
  });
});

describe("accessibleWorkspaces", () => {
  test("lists every workspace the user is a member of with their role", async (t) => {
    const other = "77f1a2b3c4d5e6f708192a3b";
    t.mock.method(Membership, "find", () =>
      fakeQuery([fakeDoc({ workspaceId: WID, role: "owner" }), fakeDoc({ workspaceId: other, role: "viewer" })]),
    );
    const find = t.mock.method(Workspace, "find", () =>
      fakeQuery([fakeDoc({ _id: other, name: "Shared" }), fakeDoc({ _id: WID, name: "Mine" })]),
    );

    const result = await accessibleWorkspaces(UID);
    assert.deepEqual(
      result.map((r) => [r.workspace.get("name"), r.role]),
      [
        ["Shared", "viewer"],
        ["Mine", "owner"],
      ],
    );
    assert.deepEqual(find.mock.calls[0].arguments[0], { _id: { $in: [WID, other] } });
  });

  test("returns an empty list for a user with no memberships", async (t) => {
    t.mock.method(Membership, "find", () => fakeQuery([]));
    t.mock.method(Workspace, "find", () => fakeQuery([]));
    assert.deepEqual(await accessibleWorkspaces(UID), []);
  });
});
