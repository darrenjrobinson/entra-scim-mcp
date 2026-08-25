import { describe, it, expect } from "vitest";
import { MockStore } from "../../src/mock/store.js";
import { MockScimError } from "../../src/mock/errors.js";
import { SCHEMA_USER_CORE, SCHEMA_GROUP_CORE } from "../../src/scim/types.js";

function user(userName: string): {
  schemas: string[];
  userName: string;
  displayName: string;
} {
  return { schemas: [SCHEMA_USER_CORE], userName, displayName: userName };
}

function group(displayName: string): { schemas: string[]; displayName: string } {
  return { schemas: [SCHEMA_GROUP_CORE], displayName };
}

describe("MockStore users", () => {
  it("creates users with ids and meta", () => {
    const store = new MockStore();
    const created = store.createUser(user("a@x.com"));
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.meta?.resourceType).toBe("user");
    expect(created.meta?.location).toBe(`/users/${created.id}`);
    expect(store.getUser(created.id)?.userName).toBe("a@x.com");
  });

  it("rejects duplicate userName case-insensitively with 409 uniqueness", () => {
    const store = new MockStore();
    store.createUser(user("a@x.com"));
    const err = captureError(() => store.createUser(user("A@X.COM")));
    expect(err).toBeInstanceOf(MockScimError);
    expect((err as MockScimError).status).toBe(409);
    expect((err as MockScimError).scimType).toBe("uniqueness");
  });

  it("frees the userName after delete", () => {
    const store = new MockStore();
    const created = store.createUser(user("a@x.com"));
    expect(store.deleteUser(created.id)).toBe(true);
    expect(() => store.createUser(user("a@x.com"))).not.toThrow();
  });

  it("re-indexes userName on putUser and blocks collisions", () => {
    const store = new MockStore();
    const a = store.createUser(user("a@x.com"));
    store.createUser(user("b@x.com"));
    const renamed = { ...structuredClone(a), userName: "b@x.com" };
    const err = captureError(() => store.putUser(renamed));
    expect((err as MockScimError).status).toBe(409);
    const fine = { ...structuredClone(a), userName: "c@x.com" };
    store.putUser(fine);
    expect(store.getUser(a.id)?.userName).toBe("c@x.com");
    expect(() => store.createUser(user("a@x.com"))).not.toThrow();
  });
});

describe("MockStore groups and membership", () => {
  it("adds members idempotently", () => {
    const store = new MockStore();
    const u1 = store.createUser(user("a@x.com"));
    const g = store.createGroup(group("G"));
    store.addGroupMembers(g.id, [u1.id]);
    store.addGroupMembers(g.id, [u1.id]);
    expect(store.getGroup(g.id)?.members).toHaveLength(1);
  });

  it("fails the whole add when any member id is invalid", () => {
    const store = new MockStore();
    const u1 = store.createUser(user("a@x.com"));
    const g = store.createGroup(group("G"));
    const err = captureError(() => store.addGroupMembers(g.id, [u1.id, "missing-id"]));
    expect((err as MockScimError).status).toBe(400);
    expect((err as MockScimError).message).toContain("does not exist");
    expect(store.getGroup(g.id)?.members).toHaveLength(0);
  });

  it("removes a member and reports group membership for users", () => {
    const store = new MockStore();
    const u1 = store.createUser(user("a@x.com"));
    const g = store.createGroup(group("G"));
    store.addGroupMembers(g.id, [u1.id]);
    expect(store.groupIdsOfUser(u1.id)).toEqual([g.id]);
    store.removeGroupMember(g.id, u1.id);
    expect(store.groupIdsOfUser(u1.id)).toEqual([]);
  });

  it("removes deleted users from group membership", () => {
    const store = new MockStore();
    const u1 = store.createUser(user("a@x.com"));
    const g = store.createGroup(group("G"));
    store.addGroupMembers(g.id, [u1.id]);
    store.deleteUser(u1.id);
    expect(store.getGroup(g.id)?.members).toHaveLength(0);
  });

  it("ignores seed group members that are provided inline", () => {
    const store = new MockStore();
    const { userIds, groupIds } = store.seed({
      users: [user("a@x.com")],
      groups: [group("G")],
    });
    expect(userIds).toHaveLength(1);
    expect(groupIds).toHaveLength(1);
  });
});

function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}
