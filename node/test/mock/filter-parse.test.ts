import { describe, it, expect } from "vitest";
import { groupMatches, parseFilter, userMatches } from "../../src/mock/filter-parse.js";
import { FilterValidationError } from "../../src/scim/errors.js";
import { MockStore } from "../../src/mock/store.js";
import {
  SCHEMA_ENTRA_USER,
  SCHEMA_GROUP_CORE,
  SCHEMA_USER_CORE,
} from "../../src/scim/types.js";

describe("parseFilter", () => {
  it("parses a single eq clause with canonical attr casing", () => {
    const clauses = parseFilter('userName eq "a@x.com"', "user");
    expect(clauses).toEqual([{ attr: "userName", op: "eq", value: "a@x.com" }]);
  });

  it("parses URN-qualified mailNickname", () => {
    const clauses = parseFilter(
      `${SCHEMA_ENTRA_USER}:mailNickname eq "nick"`,
      "user",
    );
    expect(clauses[0]!.attr).toBe(`${SCHEMA_ENTRA_USER}:mailNickname`);
  });

  it("parses and-combined clauses", () => {
    const clauses = parseFilter(
      'groups.value eq "g-1" and id eq "u-1"',
      "user",
    );
    expect(clauses).toHaveLength(2);
  });

  it("rejects or", () => {
    expect(() =>
      parseFilter('userName eq "a" or userName eq "b"', "user"),
    ).toThrow(FilterValidationError);
  });

  it("rejects unsupported operators", () => {
    expect(() => parseFilter('userName co "a"', "user")).toThrow(
      FilterValidationError,
    );
  });

  it("rejects attributes outside the allow-list", () => {
    expect(() => parseFilter('displayName eq "a"', "user")).toThrow(
      FilterValidationError,
    );
  });

  it("rejects externalId combined with other clauses", () => {
    expect(() =>
      parseFilter('externalId eq "e-1" and userName eq "a"', "user"),
    ).toThrow(FilterValidationError);
  });

  it("handles escaped quotes in values", () => {
    const clauses = parseFilter('userName eq "a\\"b"', "user");
    expect(clauses[0]!.value).toBe('a"b');
  });

  it("rejects garbage", () => {
    expect(() => parseFilter("this is not scim", "user")).toThrow(
      FilterValidationError,
    );
  });
});

describe("userMatches / groupMatches", () => {
  const store = new MockStore();
  const u1 = store.createUser({
    schemas: [SCHEMA_USER_CORE],
    userName: "Adele.V@Contoso.com",
    displayName: "Adele",
    [SCHEMA_ENTRA_USER]: { mailNickname: "adelev" },
  });
  const u2 = store.createUser({
    schemas: [SCHEMA_USER_CORE],
    userName: "b@other.org",
    displayName: "B",
  });
  const g1 = store.createGroup({
    schemas: [SCHEMA_GROUP_CORE],
    displayName: "Engineering",
  });
  store.addGroupMembers(g1.id, [u1.id]);
  const ctx = { groupIdsOfUser: (id: string) => store.groupIdsOfUser(id) };

  it("matches userName eq case-insensitively", () => {
    const clauses = parseFilter('userName eq "adele.v@contoso.com"', "user");
    expect(userMatches(u1, clauses, ctx)).toBe(true);
    expect(userMatches(u2, clauses, ctx)).toBe(false);
  });

  it("matches ew as endsWith", () => {
    const clauses = parseFilter('userName ew "@contoso.com"', "user");
    expect(userMatches(u1, clauses, ctx)).toBe(true);
    expect(userMatches(u2, clauses, ctx)).toBe(false);
  });

  it("matches the Entra mailNickname extension attribute", () => {
    const clauses = parseFilter(
      `${SCHEMA_ENTRA_USER}:mailNickname eq "ADELEV"`,
      "user",
    );
    expect(userMatches(u1, clauses, ctx)).toBe(true);
  });

  it("matches groups.value through membership", () => {
    const clauses = parseFilter(`groups.value eq "${g1.id}"`, "user");
    expect(userMatches(u1, clauses, ctx)).toBe(true);
    expect(userMatches(u2, clauses, ctx)).toBe(false);
  });

  it("matches groups by displayName and members.value", () => {
    expect(
      groupMatches(g1, parseFilter('displayName eq "engineering"', "group")),
    ).toBe(true);
    expect(
      groupMatches(g1, parseFilter(`members.value eq "${u1.id}"`, "group")),
    ).toBe(true);
    expect(
      groupMatches(g1, parseFilter(`members.value eq "${u2.id}"`, "group")),
    ).toBe(false);
  });
});
