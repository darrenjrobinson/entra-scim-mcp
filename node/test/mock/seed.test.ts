import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoSeed, loadSeedFile } from "../../src/mock/seed.js";
import { MockStore } from "../../src/mock/store.js";

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

  it("reports a missing file rather than swallowing it", async () => {
    await expect(loadSeedFile(join(dir, "absent.json"))).rejects.toThrow(/ENOENT/);
  });
});
