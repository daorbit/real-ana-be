import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { TOTP } from "otplib";
import { NodeCryptoPlugin } from "@otplib/plugin-crypto-node";
import { ScureBase32Plugin } from "@otplib/plugin-base32-scure";
import type { Response } from "express";
import {
  confirmOwnership,
  hasOwnershipFactor,
  rejectUnconfirmed,
  sendThrottled,
} from "./confirm-identity.service.js";
import { AttemptLock } from "./models/AttemptLock.js";
import { encryptSecret } from "../../shared/utils/crypto-box.js";
import { fakeQuery, fakeResponse } from "../../test-support/mongoose-fakes.js";

type UserArg = Parameters<typeof confirmOwnership>[0];

const totp = new TOTP({ crypto: new NodeCryptoPlugin(), base32: new ScureBase32Plugin() });

let passwordHash = "";
let pinHash = "";
let totpSecret = "";

function user(fields: Record<string, unknown>): UserArg {
  return { id: "u1", ...fields } as unknown as UserArg;
}

function asResponse(res: ReturnType<typeof fakeResponse>): Response {
  return res as unknown as Response;
}

before(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key";
  passwordHash = await bcrypt.hash("correct horse", 4);
  pinHash = await bcrypt.hash("4821", 4);
  totpSecret = totp.generateSecret();
});

describe("sendThrottled", () => {
  test("answers 429 with the retry time", () => {
    const res = fakeResponse();
    const until = new Date("2026-10-24T10:15:00.000Z");
    sendThrottled(asResponse(res), until);
    assert.equal(res.statusCode, 429);
    assert.deepEqual(res.body, { error: "too many attempts — try again later", retryAt: "2026-10-24T10:15:00.000Z" });
  });
});

describe("hasOwnershipFactor", () => {
  test("is true for a password, an authenticator or a PIN", () => {
    assert.equal(hasOwnershipFactor(user({ passwordHash: "x" })), true);
    assert.equal(hasOwnershipFactor(user({ totpEnabled: true })), true);
    assert.equal(hasOwnershipFactor(user({ pinHash: "x" })), true);
  });

  test("is false for an account with none of them", () => {
    assert.equal(hasOwnershipFactor(user({})), false);
  });
});

describe("confirmOwnership", () => {
  test("checks the password when the account has one", async () => {
    assert.equal(await confirmOwnership(user({ passwordHash }), { password: "correct horse" }), true);
    assert.equal(await confirmOwnership(user({ passwordHash }), { password: "wrong" }), false);
    assert.equal(await confirmOwnership(user({ passwordHash }), {}), false);
  });

  test("ignores codes when a password is required", async () => {
    assert.equal(await confirmOwnership(user({ passwordHash, pinHash }), { code: "4821" }), false);
  });

  test("accepts a current authenticator code", async () => {
    const totpSecretEnc = encryptSecret(totpSecret);
    const code = await totp.generate({ secret: totpSecret });
    assert.equal(await confirmOwnership(user({ totpEnabled: true, totpSecretEnc }), { code }), true);
    assert.equal(
      await confirmOwnership(user({ totpEnabled: true, totpSecretEnc }), { code: `${code.slice(0, 3)} ${code.slice(3)}` }),
      true,
    );
  });

  test("rejects a wrong or malformed authenticator code", async () => {
    const totpSecretEnc = encryptSecret(totpSecret);
    const code = await totp.generate({ secret: totpSecret });
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    assert.equal(await confirmOwnership(user({ totpEnabled: true, totpSecretEnc }), { code: wrong }), false);
    assert.equal(await confirmOwnership(user({ totpEnabled: true, totpSecretEnc }), { code: "12ab56" }), false);
  });

  test("rejects an authenticator code when the stored secret cannot be decrypted", async () => {
    const code = await totp.generate({ secret: totpSecret });
    assert.equal(await confirmOwnership(user({ totpEnabled: true, totpSecretEnc: "v1:broken" }), { code }), false);
  });

  test("falls back to the PIN for four-digit codes", async () => {
    assert.equal(await confirmOwnership(user({ pinHash }), { code: "4821" }), true);
    assert.equal(await confirmOwnership(user({ pinHash }), { code: "48 21" }), true);
    assert.equal(await confirmOwnership(user({ pinHash }), { code: "0000" }), false);
    assert.equal(await confirmOwnership(user({ pinHash }), { code: "48210" }), false);
  });

  test("refuses when the account has no factor at all", async () => {
    assert.equal(await confirmOwnership(user({}), { password: "x", code: "1234" }), false);
  });
});

describe("rejectUnconfirmed", () => {
  test("answers 429 while the account is locked", async (t) => {
    const until = new Date(Date.now() + 60_000);
    t.mock.method(AttemptLock, "findOne", () => fakeQuery({ lockedUntil: until }));
    const res = fakeResponse();

    assert.equal(await rejectUnconfirmed(user({ passwordHash }), { password: "correct horse" }, asResponse(res)), true);
    assert.equal(res.statusCode, 429);
  });

  test("lets the request through and clears attempts on a correct password", async (t) => {
    t.mock.method(AttemptLock, "findOne", () => fakeQuery(null));
    t.mock.method(AttemptLock, "findOneAndUpdate", () => fakeQuery({ attempts: 1 }));
    const clear = t.mock.method(AttemptLock, "deleteOne", async () => ({}));
    const res = fakeResponse();

    assert.equal(await rejectUnconfirmed(user({ passwordHash }), { password: "correct horse" }, asResponse(res)), false);
    assert.deepEqual(clear.mock.calls[0].arguments[0], { key: "confirm:u1" });
    assert.equal(res.body, undefined);
  });

  test("answers 401 with a password message on a wrong password", async (t) => {
    t.mock.method(AttemptLock, "findOne", () => fakeQuery(null));
    t.mock.method(AttemptLock, "findOneAndUpdate", () => fakeQuery({ attempts: 2 }));
    const clear = t.mock.method(AttemptLock, "deleteOne", async () => ({}));
    const res = fakeResponse();

    assert.equal(await rejectUnconfirmed(user({ passwordHash }), { password: "nope" }, asResponse(res)), true);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "incorrect password" });
    assert.equal(clear.mock.callCount(), 0);
  });

  test("answers 401 with a PIN message for accounts without a password", async (t) => {
    t.mock.method(AttemptLock, "findOne", () => fakeQuery(null));
    t.mock.method(AttemptLock, "findOneAndUpdate", () => fakeQuery({ attempts: 2 }));
    const res = fakeResponse();

    await rejectUnconfirmed(user({ pinHash }), { code: "1111" }, asResponse(res));
    assert.deepEqual(res.body, { error: "incorrect PIN or code" });
  });
});
