import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { resolveGoogleUser } from "./google-login.service.js";
import { User } from "./models/User.js";
import { fakeDoc, fakeQuery } from "../../test-support/mongoose-fakes.js";

const PROFILE = {
  sub: "google-123",
  email: "ada@example.com",
  name: "Ada King Lovelace",
  picture: "https://lh3.googleusercontent.com/ada.png",
};

type Profile = Parameters<typeof resolveGoogleUser>[0];

before(() => {
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
});

describe("resolveGoogleUser", () => {
  test("creates an account for a new email and splits the name", async (t) => {
    t.mock.method(User, "findOne", () => fakeQuery(null));
    const create = t.mock.method(User, "create", async (fields: Record<string, unknown>) => fakeDoc(fields));

    const result = await resolveGoogleUser(PROFILE as Profile);
    assert.equal(result.created, true);
    assert.deepEqual(create.mock.calls[0].arguments[0], {
      email: "ada@example.com",
      name: "Ada King Lovelace",
      firstName: "Ada",
      lastName: "King Lovelace",
      googleId: "google-123",
      avatarUrl: "https://lh3.googleusercontent.com/ada.png",
    });
  });

  test("handles a single-word name", async (t) => {
    t.mock.method(User, "findOne", () => fakeQuery(null));
    const create = t.mock.method(User, "create", async (fields: Record<string, unknown>) => fakeDoc(fields));
    await resolveGoogleUser({ ...PROFILE, name: "Cher" } as Profile);
    const fields = create.mock.calls[0].arguments[0] as { firstName: string; lastName: string };
    assert.equal(fields.firstName, "Cher");
    assert.equal(fields.lastName, "");
  });

  test("links Google to an existing email account and keeps its avatar", async (t) => {
    const existing = fakeDoc({ email: PROFILE.email, googleId: undefined as string | undefined, avatarUrl: "https://cdn/own.png" });
    t.mock.method(User, "findOne", () => fakeQuery(existing));
    const create = t.mock.method(User, "create", async () => fakeDoc({}));

    const result = await resolveGoogleUser(PROFILE as Profile);
    assert.equal(result.created, false);
    assert.equal(result.user, existing);
    assert.equal(existing.googleId, "google-123");
    assert.equal(existing.avatarUrl, "https://cdn/own.png");
    assert.equal(existing.saved, 1);
    assert.equal(create.mock.callCount(), 0);
  });

  test("fills in a missing avatar when linking", async (t) => {
    const existing = fakeDoc({ email: PROFILE.email, googleId: undefined as string | undefined, avatarUrl: undefined as string | undefined });
    t.mock.method(User, "findOne", () => fakeQuery(existing));
    await resolveGoogleUser(PROFILE as Profile);
    assert.equal(existing.avatarUrl, PROFILE.picture);
  });

  test("leaves an already linked account untouched", async (t) => {
    const existing = fakeDoc({ email: PROFILE.email, googleId: "google-123" });
    t.mock.method(User, "findOne", () => fakeQuery(existing));
    const result = await resolveGoogleUser(PROFILE as Profile);
    assert.equal(result.created, false);
    assert.equal(existing.saved, 0);
  });

  test("looks the user up by email", async (t) => {
    const find = t.mock.method(User, "findOne", () => fakeQuery(fakeDoc({ googleId: "g" })));
    await resolveGoogleUser(PROFILE as Profile);
    assert.deepEqual(find.mock.calls[0].arguments[0], { email: "ada@example.com" });
  });
});
