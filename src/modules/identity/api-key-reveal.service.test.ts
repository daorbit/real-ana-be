import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { decryptApiKey, loadRevealTarget } from "./api-key-reveal.service.js";
import { ApiKey } from "./models/ApiKey.js";
import { User } from "./models/User.js";
import { encryptSecret } from "../../shared/utils/crypto-box.js";
import { fakeDoc, fakeQuery } from "../../test-support/mongoose-fakes.js";

const WID = "66f1a2b3c4d5e6f708192a3b";
const KEY_ID = "77f1a2b3c4d5e6f708192a3b";
const UID = "65a2b3c4d5e6f708192a3b4c";

type KeyArg = Parameters<typeof decryptApiKey>[0];

before(() => {
  process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key";
});

describe("loadRevealTarget", () => {
  test("only looks at live keys in the same workspace", async (t) => {
    const find = t.mock.method(ApiKey, "findOne", () => fakeQuery(fakeDoc({ keyEnc: "v1:x" })));
    t.mock.method(User, "findById", () => fakeQuery(fakeDoc({})));
    await loadRevealTarget(WID, KEY_ID, UID);
    assert.deepEqual(find.mock.calls[0].arguments[0], { _id: KEY_ID, workspaceId: WID, revoked: false });
  });

  test("answers 404 for a missing key", async (t) => {
    t.mock.method(ApiKey, "findOne", () => fakeQuery(null));
    t.mock.method(User, "findById", () => fakeQuery(fakeDoc({})));
    assert.deepEqual(await loadRevealTarget(WID, KEY_ID, UID), { ok: false, status: 404, error: "key not found" });
  });

  test("answers 404 for a missing user", async (t) => {
    t.mock.method(ApiKey, "findOne", () => fakeQuery(fakeDoc({ keyEnc: "v1:x" })));
    t.mock.method(User, "findById", () => fakeQuery(null));
    assert.deepEqual(await loadRevealTarget(WID, KEY_ID, UID), { ok: false, status: 404, error: "not found" });
  });

  test("answers 409 for keys made before they could be revealed", async (t) => {
    t.mock.method(ApiKey, "findOne", () => fakeQuery(fakeDoc({ keyEnc: undefined })));
    t.mock.method(User, "findById", () => fakeQuery(fakeDoc({})));
    const result = await loadRevealTarget(WID, KEY_ID, UID);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 409);
  });

  test("returns the key and user when everything is in place", async (t) => {
    const key = fakeDoc({ keyEnc: "v1:x" });
    const user = fakeDoc({ passwordHash: "h" });
    t.mock.method(ApiKey, "findOne", () => fakeQuery(key));
    t.mock.method(User, "findById", () => fakeQuery(user));
    assert.deepEqual(await loadRevealTarget(WID, KEY_ID, UID), { ok: true, key, user });
  });
});

describe("decryptApiKey", () => {
  test("decrypts the stored key", () => {
    const key = fakeDoc({ keyEnc: encryptSecret("ql_live_abc123") }) as unknown as KeyArg;
    assert.equal(decryptApiKey(key), "ql_live_abc123");
  });

  test("returns null for a missing or damaged key", () => {
    assert.equal(decryptApiKey(fakeDoc({}) as unknown as KeyArg), null);
    assert.equal(decryptApiKey(fakeDoc({ keyEnc: "v1:a:b:c" }) as unknown as KeyArg), null);
  });
});
