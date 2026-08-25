import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoSeed, loadSeedFile } from "../../src/mock/seed.js";
import { MockStore } from "../../src/mock/store.js";
import { SCHEMA_GROUP_CORE, SCHEMA_USER_CORE } from "../../src/scim/types.js";

let dir: string;
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "entra-scim-seed-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write `text` verbatim so malformed JSON can be tested too. */
async function seedFile(text: string): Promise<string> {
  const path = join(dir, `seed-${counter++}.json`);
  await writeFile(path, text, "utf8");
  return path;
}

describe("loadSeedFile", () => {
  it("loads users and groups", async () => {
    const path = await seedFile(JSON.stringify(demoSeed()));
    const data = await loadSeedFile(path);
    expect(data.users).toHaveLength(2);
    expect(data.groups).toHaveLength(1);
  });

  it("round-trips a demo seed into a store", async () => {
    const path = await seedFile(JSON.stringify(demoSeed()));
    const store = new MockStore();
    const { userIds, groupIds } = store.seed(await loadSeedFile(path));
    expect(userIds).toHaveLength(2);
    expect(groupIds).toHaveLength(1);
  });

  it("accepts a file with only one of the two keys", async () => {
    const path = await seedFile(JSON.stringify({ groups: [] }));
    const data = await loadSeedFile(path);
    expect(data.groups).toEqual([]);
    expect("users" in data).toBe(false);
  });

  it("names the file when the JSON is malformed", async () => {
    const path = await seedFile('{"users": [},');
    await expect(loadSeedFile(path)).rejects.toThrow(
      new RegExp(`Seed file .*is not valid JSON`),
    );
  });

  // An array is a JSON object to `typeof`, which is what the old guard used.
  it.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"users"'],
    ["a number", "42"],
  ])("rejects a top level that is %s", async (_label, text) => {
    const path = await seedFile(text);
    await expect(loadSeedFile(path)).rejects.toThrow(
      /must contain a JSON object with optional "users" and "groups" arrays/,
    );
  });

  it.each([
    ["users", '{"users": {"userName": "a@x"}}'],
    ["groups", '{"groups": "All Employees"}'],
  ])("rejects %s when it is not an array", async (key, text) => {
    const path = await seedFile(text);
    await expect(loadSeedFile(path)).rejects.toThrow(
      new RegExp(`"${key}" must be an array`),
    );
  });

  it.each([
    ["a string", '{"users": [{"userName": "a@x"}, "nope"]}', String.raw`users\[1\]`],
    ["null", '{"users": [null]}', String.raw`users\[0\]`],
    ["a nested array", '{"groups": [[]]}', String.raw`groups\[0\]`],
  ])("rejects an entry that is %s", async (_label, text, pointer) => {
    const path = await seedFile(text);
    await expect(loadSeedFile(path)).rejects.toThrow(
      new RegExp(`"${pointer}" must be a JSON object`),
    );
  });

  it("rejects an object carrying neither key", async () => {
    const path = await seedFile('{"tenants": []}');
    await expect(loadSeedFile(path)).rejects.toThrow(/use --no-seed/);
  });

  // Everything below reached MockStore before the nested validation existed:
  // the first two as a bare TypeError, the rest as a SCIM error about a
  // "request" — for a file, at a CLI that had not started serving.
  it.each([
    [
      "a null member",
      '{"groups":[{"displayName":"G","members":[null]}]}',
      "groups[0].members[0]",
    ],
    [
      "members that is not an array",
      '{"groups":[{"displayName":"G","members":"nope"}]}',
      "groups[0].members",
    ],
    [
      "a member with no value",
      '{"groups":[{"displayName":"G","members":[{"display":"x"}]}]}',
      "groups[0].members[0].value",
    ],
    [
      "a member value that is not a string",
      '{"groups":[{"displayName":"G","members":[{"value":42}]}]}',
      "groups[0].members[0].value",
    ],
    [
      "a group with no displayName",
      '{"groups":[{"mailNickname":"g"}]}',
      "groups[0].displayName",
    ],
    [
      "a userName that is not a string",
      '{"users":[{"userName":42}]}',
      "users[0].userName",
    ],
    ["an empty userName", '{"users":[{"userName":""}]}', "users[0].userName"],
    [
      "schemas that is not an array of strings",
      '{"users":[{"userName":"a@x","schemas":[1]}]}',
      "users[0].schemas",
    ],
  ])("rejects %s, naming the file and the key", async (_label, text, pointer) => {
    const path = await seedFile(text);
    // Both halves of the guarantee: which file, and which key inside it.
    // toThrow(string) is a substring match, so the path's backslashes and the
    // pointer's brackets need no escaping.
    await expect(loadSeedFile(path)).rejects.toThrow(path);
    await expect(loadSeedFile(path)).rejects.toThrow(`"${pointer}"`);
  });

  it("never lets a malformed seed reach the store", async () => {
    // The guarantee the validation exists for: whatever the file contains,
    // loadSeedFile either rejects it by name or hands the store something it
    // can seed without throwing.
    const malformed = [
      '{"groups":[{"displayName":"G","members":[null]}]}',
      '{"groups":[{"displayName":"G","members":"nope"}]}',
      '{"users":[{"userName":42}]}',
      '{"groups":[{"mailNickname":"g"}]}',
    ];
    for (const text of malformed) {
      const path = await seedFile(text);
      await expect(loadSeedFile(path)).rejects.toThrow(/^Seed file /);
    }
  });

  it("accepts a group carrying well-formed members", async () => {
    const path = await seedFile(
      JSON.stringify({
        users: [{ schemas: [SCHEMA_USER_CORE], userName: "a@x.com" }],
        groups: [{ schemas: [SCHEMA_GROUP_CORE], displayName: "G", members: [] }],
      }),
    );
    const store = new MockStore();
    const { userIds, groupIds } = store.seed(await loadSeedFile(path));
    expect(userIds).toHaveLength(1);
    expect(groupIds).toHaveLength(1);
  });

  it("reports a missing file rather than swallowing it", async () => {
    await expect(loadSeedFile(join(dir, "absent.json"))).rejects.toThrow(/ENOENT/);
  });
});
